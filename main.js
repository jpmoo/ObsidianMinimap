const { Plugin, MarkdownView } = require("obsidian");

class NoteMinimap extends Plugin {
    updateInterval = null;
    activeNoteView = null;
    updateNeeded = false;
    noteInstances = new Map(); // element: noteInstance

    onload() {
        console.log("NoteMinimap Loaded");

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

        // Manage active leaf
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (newActiveLeaf) => {
                this.updateElementMinimap(); // old leaf
                this.activeNoteView = newActiveLeaf.view;
                console.log(
                    "Active leaf changed, current active view:",
                    this.activeNoteView
                );
                this.updateElementMinimap(); // new leaf
            })
        );

        // Update previews as needed
        this.registerEvent(
            this.app.workspace.on(
                "editor-change",
                () => (this.updateNeeded = true)
            )
        );
        this.updateInterval = setInterval(() => {
            if (this.updateNeeded) {
                this.updateNeeded = false;
                this.updateElementMinimap();
            }
        }, 1000);

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
                        console.log("note closed", el);
                        note.destroy();
                        this.noteInstances.delete(el);
                        this.resizeObserver.unobserve(el);
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
        
        // Destroy all Note instances and disconnect resizeObserver
        this.noteInstances.forEach((noteInstance) => noteInstance.destroy());
        this.resizeObserver.disconnect();

        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        console.log("NoteMinimap Unloaded");
    }

    injectMinimapIntoAllNotes() {
        const leaves = this.app.workspace.getLeavesOfType("markdown");
        for (const leaf of leaves) {
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

        // Update or create the Note instance for this element
        if (this.noteInstances.has(element)) {
            const noteInstance = this.noteInstances.get(element);
            noteInstance.updateIframe();
        } else {
            const noteInstance = new Note(element);
            this.noteInstances.set(element, noteInstance);
            this.resizeObserver.observe(element);
            // console.log("Created new Note instance for leaf:", element);
        }
    }
}

class Note {
    scale = 0.15;
    constructor(element) {
        this.element = element;
        this.scroller = this.element.querySelector(".cm-scroller");
        this.sizer = this.element.querySelector(".cm-sizer");
        this.updateSlider = this.updateSlider.bind(this);
        this.onSliderMouseDown = this.onSliderMouseDown.bind(this);

        this.iframe = this.getIframe();
        this.slider = this.getSlider();
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

    getIframe() {
        let iframe = this.element.querySelector(".minimap-frame");
        if (!iframe) {
            // console.log("Setting up a new iframe for mini preview");
            iframe = document.createElement("iframe");
            iframe.className = "minimap-frame";
            this.element.querySelector(".cm-editor").appendChild(iframe);
        }
        return iframe;
    }

    getSlider() {
        let slider = this.element.querySelector(".minimap-slider");
        if (!slider) {
            // console.log("Setting up a new div for viewport slider");
            slider = document.createElement("div");
            slider.className = "minimap-slider";
            this.element.querySelector(".cm-editor").appendChild(slider);
        }
        return slider;
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
		<body class="${themeClass} markdown-preview-view show-inline-title">${noteContent.innerHTML}</body>
		</html>
	`;

        this.iframe.srcdoc = html;
    }

    updateSlider() {
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

        noteContent.querySelector(".cm-sizer").style = "";
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
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
    };
}
