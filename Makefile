# Build targets for the Python REPL Chrome extension.

UV ?= uv
NODE ?= node
NPM ?= npm
VENDOR_DIR := vendor/pyodide
ICON_SIZES := 16 48 128
ICONS := $(foreach s,$(ICON_SIZES),icons/icon$(s).png)
DIST_DIR := dist
# Version comes from manifest.json so the zip name can't drift from it.
VERSION := $(shell $(NODE) -p 'require("./manifest.json").version')
ZIP := $(DIST_DIR)/python-repl-$(VERSION).zip
# Everything the extension loads at runtime. vendor/pyodide is added whole.
RUNTIME_FILES := manifest.json protocol.js background.js offscreen.html offscreen.js \
	worker.js interrupt-buffer.js popup.html popup.js popup-lib.js popup.css
SMOKE_DIR := .cache/chrome-test
# Upstream license texts, written by scripts/fetch_pyodide.py next to the
# runtime and placed at the zip root by `make zip`.
NOTICES := $(VENDOR_DIR)/THIRD_PARTY_NOTICES.txt

.PHONY: vendor icons test zip smoke screenshots store-assets demo-gif demo-video clean-vendor clean-dist

vendor: $(VENDOR_DIR)/pyodide.mjs

$(VENDOR_DIR)/pyodide.mjs: scripts/fetch_pyodide.py
	$(UV) run scripts/fetch_pyodide.py

icons: $(ICONS)

# One rule run writes every size; make 3.81 (macOS) has no grouped targets, so
# the other sizes depend on the last one written.
ICON_LAST := icons/icon$(lastword $(ICON_SIZES)).png
$(ICON_LAST): scripts/gen_icons.py
	$(UV) run scripts/gen_icons.py
$(filter-out $(ICON_LAST),$(ICONS)): $(ICON_LAST)

test: vendor
	$(NODE) --test tests/

zip: vendor icons
	mkdir -p $(DIST_DIR)
	rm -f $(ZIP)
	zip -X -r $(ZIP) $(RUNTIME_FILES) $(ICONS) LICENSE $(VENDOR_DIR) -x '*/.DS_Store' -x $(NOTICES)
	zip -X -j $(ZIP) $(NOTICES)
	@echo "wrote $(ZIP)"

# Chrome smoke test: puppeteer + Chrome for Testing, installed locally in
# $(SMOKE_DIR) (gitignored), never globally.
$(SMOKE_DIR)/node_modules/puppeteer/package.json: tests/chrome-smoke.package.json
	mkdir -p $(SMOKE_DIR)
	cp tests/chrome-smoke.package.json $(SMOKE_DIR)/package.json
	cd $(SMOKE_DIR) && PUPPETEER_CACHE_DIR=$(CURDIR)/$(SMOKE_DIR)/browsers $(NPM) install --no-audit --no-fund

smoke: vendor icons $(SMOKE_DIR)/node_modules/puppeteer/package.json
	PUPPETEER_CACHE_DIR=$(CURDIR)/$(SMOKE_DIR)/browsers $(NODE) tests/chrome-smoke.mjs

# README images in docs/screenshots/ (committed), from the same puppeteer setup.
screenshots: vendor icons $(SMOKE_DIR)/node_modules/puppeteer/package.json
	PUPPETEER_CACHE_DIR=$(CURDIR)/$(SMOKE_DIR)/browsers $(NODE) scripts/screenshots.mjs readme

# Chrome Web Store screenshots (1280x800, real browser-window captures; macOS
# only, see demo-gif) and promo tile (440x280, rendered) in docs/store/
# (committed); see docs/store-listing.md.
store-assets: vendor icons $(SMOKE_DIR)/node_modules/puppeteer/package.json
	PUPPETEER_CACHE_DIR=$(CURDIR)/$(SMOKE_DIR)/browsers $(NODE) scripts/demo.mjs store
	$(UV) run scripts/demo_assemble.py store
	PUPPETEER_CACHE_DIR=$(CURDIR)/$(SMOKE_DIR)/browsers $(NODE) scripts/screenshots.mjs promo

# README demo docs/demo.gif (committed): records the real Chrome window with
# `screencapture`, from a fresh profile so the popup shows the first-open
# banner. macOS only; the terminal needs the Screen Recording permission, and
# the window's screen area must stay unobstructed.
demo-gif: vendor icons $(SMOKE_DIR)/node_modules/puppeteer/package.json
	PUPPETEER_CACHE_DIR=$(CURDIR)/$(SMOKE_DIR)/browsers $(NODE) scripts/demo.mjs gif
	$(UV) run scripts/demo_assemble.py gif

# Upload video $(DIST_DIR)/demo.mp4 (1920x1080 H.264, 30 fps, not committed):
# the same recording as the GIF at full resolution. Assembles the last
# `make demo-gif` recording in .cache/demo/gif/; it does not record.
demo-video:
	$(UV) run scripts/demo_assemble.py video

clean-vendor:
	rm -rf $(VENDOR_DIR)

clean-dist:
	rm -rf $(DIST_DIR)
