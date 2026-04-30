.PHONY: tag release tap audit

VERSION ?= $(shell git describe --tags --abbrev=0 2>/dev/null || echo "v1.0.0")
NEXT    ?= v1.0.0
TAP_DIR ?= $(HOME)/projects/homebrew-rtl433-ui
TAP_FORMULA = $(TAP_DIR)/Formula/rtl433-ui.rb

# ── Local development ──────────────────────────────────────────────────────
# Register the local tap and install --HEAD (uses your local git repo).
tap:
	brew tap dalekunce/rtl433-ui "$(TAP_DIR)" 2>/dev/null || true
	brew install --HEAD rtl433-ui

# Re-install after source changes (faster than full reinstall).
reinstall:
	brew reinstall --HEAD rtl433-ui

# ── Production release ─────────────────────────────────────────────────────
# Usage: make release NEXT=v1.2.0
# 1. Tags the commit, 2. generates the tarball sha256, 3. patches the formula.
#
# Prerequisites: push the tag to GitHub first so the tarball URL is live.
#   git push origin main --tags
release:
	@echo "==> Tagging $(NEXT)"
	git tag -a $(NEXT) -m "Release $(NEXT)"
	@echo ""
	@echo "==> Push the tag, then run: make formula NEXT=$(NEXT)"

# Fetch the tarball from GitHub and update the formula url/sha256/version.
formula:
	$(eval URL  := https://github.com/dalekunce/rtl433-ui/archive/refs/tags/$(NEXT).tar.gz)
	$(eval SHA  := $(shell curl -sL "$(URL)" | sha256sum | awk '{print $$1}'))
	@echo "URL:    $(URL)"
	@echo "sha256: $(SHA)"
	@sed -i '' \
	  -e 's|^  head .*|  url "$(URL)"|' \
	  -e '/^  # ── Local development/,/^  # ─────/d' \
	  "$(TAP_FORMULA)"
	@sed -i '' "s|sha256 \".*\"|sha256 \"$(SHA)\"|" "$(TAP_FORMULA)" || \
	  sed -i '' "s|url \"$(URL)\"|url \"$(URL)\"\n  sha256 \"$(SHA)\"\n  version \"$(NEXT)\"|" "$(TAP_FORMULA)"
	@echo "==> Formula updated. Commit and push $(TAP_DIR)."

# ── Lint ───────────────────────────────────────────────────────────────────
audit:
	brew audit --strict --new-formula "$(TAP_FORMULA)"
