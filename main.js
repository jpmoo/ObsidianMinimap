const { Plugin, MarkdownView, setIcon } = require("obsidian");

class NoteMinimap extends Plugin {
    activeNoteView = null;
    updateNeeded = false;
    noteInstances = new Map(); // element: noteInstance
    minimapDisabledFor = new WeakSet();

    onload() {
        console.log("NoteMinimap Loaded");

        // Handle resize
        const resized = new Set(); // entry.target = element
        const resize = throttle(() => {
            for (const el of resized) {
                for (const [element, note] of this.noteInstances.entries()) {
                    if (element === el) {
                        note.onResize();
                        break; // Exit inner loop once a match is found
                    }
                }
            }
            resized.clear();
        }, 1000);
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                resized.add(entry.target);
            }
            resize();
        });

        // Handle mode change
        this.modeObserver = new MutationObserver((entries) => {
            const entry = entries[0]; // all entries will be about the same topic anyways
            const noteInstance = this.noteInstances.get(
                entry.target.parentElement
            );
            if (entry.attributeName === "style") noteInstance?.modeChange();
            this.updateElementMinimap();
        });

        // Manage active leaf
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (newActiveLeaf) => {
                this.updateElementMinimap(); // old leaf
                this.activeNoteView = newActiveLeaf.view;
                // console.log(
                //     "Active leaf changed, current active view:",
                //     this.activeNoteView
                // );
                this.updateElementMinimap(); // new leaf

                // Toggle button
                if (newActiveLeaf?.view?.getViewType() === "markdown") {
                    this.addToggleButtonToLeaf(newActiveLeaf);
                }
            })
        );

        // Update previews as needed
        this.debouncedUpdateMinimap = debounce(() => {
            this.updateElementMinimap();
        }, 700);
        this.registerEvent(
            this.app.workspace.on("editor-change", this.debouncedUpdateMinimap)
        );

        // Manage closed notes
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                // This event does not provide arguments
                const openEls = new Set(
                    this.app.workspace
                        .getLeavesOfType("markdown")
                        .map((l) => l.view.contentEl)
                );
                for (const [el, note] of this.noteInstances.entries()) {
                    if (!openEls.has(el)) {
                        // console.log("note closed", el);
                        note.destroy();
                        this.noteInstances.delete(el);
                        this.resizeObserver.unobserve(el);
                        this.modeObserver.unobserve(note.sourceView);
                    }
                }
            })
        );

        this.app.workspace.onLayoutReady(() => {
            this.activeNoteView =
                this.app.workspace.getActiveViewOfType(MarkdownView);
            this.injectMinimapIntoAllNotes();
        });
    }

    onunload() {
        // IMPORTANT: Obsidian automatically unregisters hooks made only by using this.registerEvent or this.registerDomEvent.

        // Free timeout
        if (this.debouncedUpdateMinimap?.cancel) {
            this.debouncedUpdateMinimap.cancel();
        }

        // Destroy all Note instances and disconnect Observers
        this.noteInstances.forEach((noteInstance) => noteInstance.destroy());
        this.resizeObserver.disconnect();
        this.modeObserver.disconnect();

        document
            .querySelectorAll(".minimap-toggle-button")
            .forEach((button) => button.remove());

        console.log("NoteMinimap Unloaded");
    }

    injectMinimapIntoAllNotes() {
        const leaves = this.app.workspace.getLeavesOfType("markdown");
        for (const leaf of leaves) {
            this.addToggleButtonToLeaf(leaf);
            this.updateElementMinimap(leaf.view.contentEl);
        }
    }

    updateElementMinimap(element) {
        // If no element is provided, use the active leaf
        if (!element) {
            if (!this.activeNoteView) return;
            element = this.activeNoteView.contentEl;
        }

        // A new tab and not a note
        if (element.querySelector(".empty-state")) return;

        // If disabled, remove the minimap if it exists
        if (this.minimapDisabledFor.has(element)) {
            const existing = this.noteInstances.get(element);
            if (existing) {
                existing.destroy();
                this.noteInstances.delete(element);
                this.resizeObserver.unobserve(element);
                // MutationObserver.unobserve() does not exist...
            }
            return;
        }

        // Update or create the Note instance for this element
        if (this.noteInstances.has(element)) {
            const noteInstance = this.noteInstances.get(element);
            noteInstance.updateIframe();
        } else {
            const noteInstance = new Note(element);
            this.noteInstances.set(element, noteInstance);
            this.resizeObserver.observe(element);
            this.modeObserver.observe(noteInstance.sourceView, {
                attributes: true,
            });
            // console.log("Created new Note instance for leaf:", element);
        }
    }

    addToggleButtonToLeaf(leaf) {
        const viewActions =
            leaf.view.containerEl.querySelector(".view-actions");

        if (!viewActions) return;

        // Avoid adding twice
        if (viewActions.querySelector(".minimap-toggle-button")) return;

        const button = document.createElement("button");
        button.className = "clickable-icon view-actions minimap-toggle-button";
        button.setAttribute("aria-label", "Toggle Minimap");

        // Use Obsidian's built-in icon
        setIcon(button, "star-list");

        const contentEl = leaf.view.contentEl;
        button.onclick = () => {
            if (this.minimapDisabledFor.has(contentEl)) {
                this.minimapDisabledFor.delete(contentEl);
            } else {
                this.minimapDisabledFor.add(contentEl);
            }

            this.updateElementMinimap(contentEl);
        };

        viewActions.prepend(button);
    }
}

class Note {
    scale = 0.1;
    constructor(element) {
        this.element = element;
        this.sourceView = element.querySelector(".markdown-source-view");
        this.modeChange();
        this.updateSlider = this.updateSlider.bind(this);
        this.onSliderMouseDown = this.onSliderMouseDown.bind(this);

        this.setupElements();
        this.updateIframe();
        this.updateSlider();

        // Register events - need to remove on destroy!
        this.scroller.addEventListener("scroll", this.updateSlider);
        this.slider.addEventListener("mousedown", this.onSliderMouseDown);
    }

    destroy() {
        this.scroller.removeEventListener("scroll", this.updateSlider);
        this.slider.removeEventListener("mousedown", this.onSliderMouseDown);
        document.removeEventListener("mousemove", this.onSliderMouseMove);
        document.removeEventListener("mouseup", this.onSliderMouseUp);

        this.iframe.remove();
        this.slider.remove();

        this.iframe = null;
        this.slider = null;
        // console.log("destroyed");
    }

    isReadModeActive() {
        return this.sourceView.clientHeight === 0;
    }

    modeChange() {
        // Check mode
        const isReading = this.isReadModeActive();

        // Un-bind scroll
        if (this.scroller) {
            this.scroller.removeEventListener("scroll", this.updateSlider);
            this.scroller = null;
        }

        // Select the correct scroller and sizer elements for this mode
        this.scroller = this.element.querySelector(
            isReading ? ".markdown-preview-view" : ".cm-scroller"
        );
        this.sizer = this.element.querySelector(
            isReading ? ".markdown-preview-sizer" : ".cm-sizer"
        );

        // Re-bind scroll
        if (this.scroller) {
            this.scroller.addEventListener("scroll", this.updateSlider);
        }

        // Recompute iframe and slider layout
        this.onResize();
    }

    async onResize() {
        await sleep(300);

        // updating slider height
        const visibleHeight = this.scroller.getBoundingClientRect().height;
        this.slider.style.height = `${visibleHeight * this.scale}px`;
        this.updateSlider();

        // updating iframe height
        this.iframe.style.height =
            this.sizer.getBoundingClientRect().height + "px";
    }

    setupElements() {
        this.element
            .querySelectorAll(
                ".minimap-container, .minimap-frame, .minimap-slider"
            )
            .forEach((e) => e.remove());

        const container = document.createElement("div");
        container.className = "minimap-container";
        this.element.prepend(container);

        this.iframe = document.createElement("iframe");
        this.iframe.className = "minimap-frame";
        container.appendChild(this.iframe);

        this.slider = document.createElement("div");
        this.slider.className = "minimap-slider";
        container.appendChild(this.slider);
    }

    async updateIframe() {
        const noteContent = await this.getFullHTML();
        noteContent
            .querySelectorAll(".minimap-frame, .minimap-slider")
            .forEach((el) => el.remove());

        // Clone styles
        const styleElements = Array.from(
            document.head.querySelectorAll('style, link[rel="stylesheet"]')
        );
        const stylesHTML = styleElements.map((el) => el.outerHTML).join("\n");

        const themeClass = document.body.classList.contains("theme-dark")
            ? "theme-dark"
            : "theme-light";

        const rootStyles = getComputedStyle(document.documentElement);
        let cssVars = ":root {\n";
        for (let i = 0; i < rootStyles.length; i++) {
            const prop = rootStyles[i];
            if (prop.startsWith("--")) {
                const value = rootStyles.getPropertyValue(prop);
                cssVars += `  ${prop}: ${value};\n`;
            }
        }
        cssVars += "}";

        const html = `
		<!DOCTYPE html>
		<html>
		<head>${stylesHTML}<style>${cssVars} .theme-light {--color-base-00: rgba(255, 255, 255, 0.333);} .theme-dark {--color-base-00: rgba(30, 30, 30, 0.333);}</style></head>
		<body class="${themeClass} ${
            this.isReadModeActive() ? "" : "markdown-preview-view"
        } show-inline-title">${noteContent.innerHTML}</body>
		</html>
	`;

        this.iframe.srcdoc = html;
    }

    updateSlider() {
        if (!this.scroller) return;
        const scrollTop = this.scroller.scrollTop;
        const boxTop = scrollTop * this.scale;
        this.slider.style.top = `${boxTop}px`;
    }

    // Needed since obsidian doesn't load non-visible parts of the note (can't be changed).
    async getFullHTML() {
        this.sizer.style = "transform-origin: top right; scale: .1;";
        this.element.offsetWidth; // trigger reflow
        await sleep(10);

        const noteContent = this.element.cloneNode(true);

        noteContent
            .querySelectorAll(".markdown-preview-sizer, .cm-sizer")
            .forEach((e) => (e.style = ""));
        this.sizer.style = "";

        return noteContent;
    }

    onSliderMouseDown(e) {
        e.preventDefault();
        this.isDragging = true;
        this.slider.classList.add("dragging");

        const sliderRect = this.slider.getBoundingClientRect();
        this.dragOffsetY = e.clientY - sliderRect.top;

        document.addEventListener("mousemove", this.onSliderMouseMove);
        document.addEventListener("mouseup", this.onSliderMouseUp);
    }

    onSliderMouseMove = (e) => {
        if (!this.isDragging) return;

        const editorRect = this.element.getBoundingClientRect();
        let offsetY = e.clientY - editorRect.top - this.dragOffsetY;

        // Clamp to editor bounds
        const maxScroll =
            this.scroller.scrollHeight - this.scroller.clientHeight;
        const maxOffset = maxScroll * this.scale;

        offsetY = Math.max(0, Math.min(offsetY, maxOffset));

        const scrollY = offsetY / this.scale;
        this.scroller.scrollTop = scrollY;

        this.updateSlider(); // keep slider visually synced
    };

    onSliderMouseUp = () => {
        this.isDragging = false;
        this.slider.classList.remove("dragging");
        document.removeEventListener("mousemove", this.onSliderMouseMove);
        document.removeEventListener("mouseup", this.onSliderMouseUp);
    };
}

// editor-mode-change & close-leaf are not working!

module.exports = {
    default: NoteMinimap,
};

function throttle(fn, limit, options = { leading: false, trailing: true }) {
    let inThrottle = false;
    let lastArgs, lastThis;

    const invoke = () => {
        if (lastArgs) {
            fn.apply(lastThis, lastArgs);
            lastArgs = lastThis = null;
            setTimeout(invoke, limit);
        } else {
            inThrottle = false;
        }
    };

    return function (...args) {
        if (!inThrottle) {
            if (options.leading) {
                fn.apply(this, args);
            } else {
                lastArgs = args;
                lastThis = this;
            }
            inThrottle = true;
            setTimeout(invoke, limit);
        } else if (options.trailing) {
            lastArgs = args;
            lastThis = this;
        }
    };
}

function debounce(fn, delay) {
    let timeout = null;

    function debounced(...args) {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
            timeout = null;
            fn.apply(this, args);
        }, delay);
    }

    debounced.cancel = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    };

    return debounced;
}
