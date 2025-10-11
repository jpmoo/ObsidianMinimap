const {
    Plugin,
    MarkdownView,
    setIcon,
    debounce,
    Setting,
    PluginSettingTab,
} = require("obsidian");

class MinimapSettingTab extends PluginSettingTab {
    constructor(plugin) {
        super(plugin.app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Enable by default")
            .setDesc(
                "Already opened notes will not be affected by changing this"
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.enabledByDefault)
                    .onChange((value) => {
                        this.plugin.settings.enabledByDefault = value;
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Better Rendering (Experimental)")
            .setDesc(
                "Use a hidden helper note to render the minimap, improving flickering and consistent loading. Already opened notes will not be affected by changing this"
            )
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.betterRendering)
                    .onChange((value) => {
                        this.plugin.settings.betterRendering = value;
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Scale")
            .setDesc("Change the minimap scale (0.05 - 0.3)")
            .addSlider((slider) => {
                slider
                    .setLimits(0.05, 0.3, 0.01)
                    .setValue(this.plugin.settings.scale)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.scale = value;
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Opacity")
            .setDesc("Change the minimap's background opacity (0.05 - 1)")
            .addSlider((slider) => {
                slider
                    .setLimits(0.05, 1, 0.01)
                    .setValue(this.plugin.settings.minimapOpacity)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.minimapOpacity = value;
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Slider Opacity")
            .setDesc("Change the slider opacity (0.05 - 1)")
            .addSlider((slider) => {
                slider
                    .setLimits(0.05, 1, 0.01)
                    .setValue(this.plugin.settings.sliderOpacity)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.sliderOpacity = value;
                        this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Top Offset")
            .setDesc(
                "Offset the minimap from the top (pixels) - for special plugin toolbars"
            )
            .addSlider((slider) => {
                slider
                    .setLimits(0, 100, 1)
                    .setValue(this.plugin.settings.topOffset)
                    .setDynamicTooltip()
                    .onChange((value) => {
                        this.plugin.settings.topOffset = value;
                        this.plugin.saveSettings();
                    });
            });
    }
}

class NoteMinimap extends Plugin {
    activeNoteView = null;
    updateNeeded = false;
    noteInstances = new Map(); // element: noteInstance

    async onload() {
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

        // Handle mode change, notice that there is no way to unobserve only one element
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
                    if (this.settings.betterRendering)
                        this.openHelperForLeaf(newActiveLeaf);
                    this.addToggleButtonToLeaf(newActiveLeaf);
                }
            })
        );

        // Update previews as needed
        this.debouncedUpdateMinimap = debounce(
            () => {
                this.updateElementMinimap();
            },
            700,
            true
        );
        this.registerEvent(
            this.app.workspace.on("editor-change", this.debouncedUpdateMinimap)
        );

        // Manage closed notes (and mode changes for better rendering)
        const updateHelpers = throttle(() => {
            this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
                this.updateHelperForLeaf(leaf);
            });
            this.updateElementMinimap();
        }, 500);
        this.registerEvent(
            this.app.workspace.on("layout-change", () => {
                if (this.settings.betterRendering) {
                    this.detachRedundantHelperLeaves();
                    updateHelpers();
                }
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
                    }
                }
            })
        );

        await this.loadSettings();
        this.addSettingTab(new MinimapSettingTab(this));
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
        this.detachAllHelperLeaves();

        console.log("NoteMinimap Unloaded");
    }

    async loadSettings() {
        this.settings = Object.assign(
            {
                enabledByDefault: true,
                betterRendering: false,
                scale: 0.1,
                minimapOpacity: 0.3,
                sliderOpacity: 0.3,
                topOffset: 0,
            },
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);

        // Update all existing notes
        for (const note of this.noteInstances.values()) {
            note.updateSettings(this.settings);
        }
    }

    injectMinimapIntoAllNotes() {
        const leaves = this.app.workspace.getLeavesOfType("markdown");
        for (const leaf of leaves) {
            if (this.settings.betterRendering) this.openHelperForLeaf(leaf);
            this.addToggleButtonToLeaf(leaf);
            this.updateElementMinimap(
                leaf.view.contentEl,
                this.helperLeafIds.get(leaf.id)
            );
        }
    }

    async updateElementMinimap(element, helperLeafId) {
        await sleep(100); // wait for helper to open
        const activeLeaf = this.app.workspace.activeLeaf;
        helperLeafId = this.helperLeafIds.get(activeLeaf.id);
        // If no element is provided, use the active leaf
        if (!element) {
            if (!this.activeNoteView) return;
            element = this.activeNoteView.contentEl;
        }

        // Assert it's a markdown note by checking for the two needed children
        if (
            !element.querySelector(".markdown-source-view") ||
            !element.querySelector(".markdown-preview-view")
        )
            return;

        // If disabled, remove the minimap if it exists
        if (element.classList.contains("minimap-disabled")) {
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
            const noteInstance = new Note(element, this.settings, helperLeafId);
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
            contentEl.classList.toggle("minimap-disabled");
            this.updateElementMinimap(contentEl);
        };

        // Handle disable-by-default
        if (!this.settings.enabledByDefault)
            contentEl.classList.add("minimap-disabled");

        viewActions.prepend(button);
    }

    // Functions towards switching to rendering minimap with a helper leaf instead of the actual - to improve use experience
    helperLeafIds = new Map(); // originalLeafId: helperLeafId
    async openHelperForLeaf(leaf) {
        if (!leaf) return;
        if (this.helperLeafIds.has(leaf.id)) return; // already has a helper
        if ([...this.helperLeafIds.values()].includes(leaf.id)) return; // is a helper itself
        // if (leaf.view?.getViewType() !== "markdown") return;
        const file = leaf.view.file;
        if (!file) return;

        // Create the helper leaf in the right sidebar, save its id and open the same content in it
        const rightLeaf = this.app.workspace.getRightLeaf(false);
        this.helperLeafIds.set(leaf.id, rightLeaf.id);
        this.updateHelperForLeaf(leaf);
        // console.log(`Opened helper leaf ${rightLeaf.id} for original leaf ${leaf.id}`);
    }
    detachRedundantHelperLeaves() {
        this.helperLeafIds.forEach((helperLeafId, originalLeafId) => {
            if (this.app.workspace.getLeafById(originalLeafId) === null) {
                const helperLeaf = this.app.workspace.getLeafById(helperLeafId);
                if (helperLeaf) {
                    // console.log(`Closing helper leaf ${helperLeafId} as original leaf ${originalLeafId} has closed`);
                    helperLeaf.detach();
                }
                this.helperLeafIds.delete(originalLeafId);
            }
        });
    }
    detachAllHelperLeaves() {
        this.helperLeafIds.forEach((helperLeafId) => {
            this.app.workspace.getLeafById(helperLeafId)?.detach();
        });
    }
    async updateHelperForLeaf(leaf) {
        const helperLeaf = this.app.workspace.getLeafById(
            this.helperLeafIds.get(leaf?.id)
        );
        if (!helperLeaf) return;
        // console.log("Updating helper for leaf", leaf.id);

        const oldState = helperLeaf.view.getState();
        const newState = leaf.view.getState();
        await helperLeaf.setViewState({
            type: "markdown",
            state: newState,
        });
        if (oldState.file !== newState.file)
            await this.initialForceloadContentInMarkdownView(helperLeaf.view);
    }
    async initialForceloadContentInMarkdownView(view) {
        // Force the contentEl to fully load by clearing and restoring its data - I don't know why view.clear() is the only thing that works...
        if (view?.getViewType() !== "markdown") return;
        view.contentEl
            .querySelectorAll(".markdown-preview-sizer, .cm-sizer")
            .forEach((el) => {
                el.style = "transform-origin: top right; scale: .1;";
            });
        const data = await view.getViewData();
        await view.clear();
        await sleep(100);
        await view.setViewData(data);
    }
}

class Note {
    constructor(element, settings, helperLeafId) {
        this.element = element;
        this.helperLeafId = helperLeafId;
        this.helperElement =
            app.workspace.getLeafById(helperLeafId)?.view?.contentEl;
        this.sourceView = element.querySelector(".markdown-source-view");
        this.modeChange();
        this.updateSlider = this.updateSlider.bind(this);
        this.onSliderMouseDown = this.onSliderMouseDown.bind(this);

        this.setupElements();
        this.updateSettings(settings);

        // Register events - need to remove on destroy!
        this.scroller.addEventListener("scroll", this.updateSlider);
        this.slider.addEventListener("mousedown", this.onSliderMouseDown);
    }

    updateSettings(settings) {
        this.scale = settings.scale;
        this.minimapOpacity = settings.minimapOpacity;
        this.sliderOpacity = settings.sliderOpacity;
        this.topOffset = settings.topOffset;

        if (this.iframe && this.slider) {
            this.updateSettingsInCSS();
            this.onResize();
            this.updateIframe();
            this.updateSlider();
        }
    }

    updateSettingsInCSS() {
        if (this.iframe) this.iframe.style.setProperty("--scale", this.scale);
        if (this.slider) this.slider.style.setProperty("--scale", this.scale);
        if (this.slider) this.slider.style.opacity = this.sliderOpacity;
        if (this.iframe) this.iframe.style.top = `${this.topOffset}px`;
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

        const rootStyles = getComputedStyle(
            document.documentElement.querySelector("body")
        );
        let cssVars = ":root {\n";
        for (let i = 0; i < rootStyles.length; i++) {
            const prop = rootStyles[i];
            if (prop.startsWith("--")) {
                const value = rootStyles.getPropertyValue(prop);
                cssVars += `  ${prop}: ${value};\n`;
            }
        }
        cssVars += "}";
        // Remove scrollbar inside minimap
        cssVars += "::-webkit-scrollbar {display: none;}";

        // Dynamically override --color-base-00 with alpha
        const base00Alpha = toRGBAAlpha(
            rootStyles.getPropertyValue("--color-base-00").trim(),
            this.minimapOpacity
        );
        const overrideVars = `--color-base-00: ${base00Alpha};`;

        const html = `
		<!DOCTYPE html>
		<html>
		<head>${stylesHTML}<style>${cssVars}</style></head>
		<body style="${overrideVars}" class="${themeClass} ${
            this.isReadModeActive() ? "" : "markdown-preview-view"
        } show-inline-title">${noteContent.innerHTML}</body>
		</html>
	`;

        if (this.iframe) this.iframe.srcdoc = html;
    }

    updateSlider() {
        if (!this.scroller) return;
        const scrollTop = this.scroller.scrollTop;
        const boxTop = scrollTop * this.scale + (this.topOffset || 0);
        this.slider.style.top = `${boxTop}px`;
    }

    // Needed since obsidian doesn't load non-visible parts of the note (can't be changed).
    async getFullHTML() {
        let noteContent;
        if (this.helperElement) {
            // Better Rendering: use helper note if available
            noteContent = this.helperElement.cloneNode(true);
        } else {
            // Fallback: use current note but try to force full rendering
            this.sizer.style = "transform-origin: top right; scale: .1;";
            this.element.offsetWidth; // trigger reflow
            await sleep(10);

            noteContent = this.element.cloneNode(true);
            this.sizer.style = "";
        }

        noteContent
            .querySelectorAll(".markdown-preview-sizer, .cm-sizer")
            .forEach((e) => (e.style = ""));

        // Remove other content (fix for trouble with Editing Toolbar Plugin)
        // noteContent.querySelectorAll(".markdown-reading-view > :not(.markdown-preview-view)").forEach((e) => (e.remove()));
        noteContent
            .querySelectorAll(".markdown-source-view > :not(.cm-editor)")
            .forEach((e) => e.remove());

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
        let offsetY =
            e.clientY - editorRect.top - this.dragOffsetY - this.topOffset;

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

function toRGBAAlpha(color, alpha) {
    if (color.startsWith("#")) {
        // hex to rgb
        let hex = color.replace("#", "");
        if (hex.length === 3)
            hex = hex
                .split("")
                .map((x) => x + x)
                .join("");
        const num = parseInt(hex, 16);
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return `rgba(${r},${g},${b},${alpha})`;
    } else if (color.startsWith("rgb")) {
        // rgb or rgba
        const nums = color.match(/[\d.]+/g);
        if (nums.length >= 3) {
            return `rgba(${nums[0]},${nums[1]},${nums[2]},${alpha})`;
        }
    }
    // fallback
    return color;
}
