PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply test typecheck check verify-git-install

help:
	@echo "make apply               Link this checkout into $(PI_EXTENSIONS_DIR)"
	@echo "make verify-apply        Verify the local extension link"
	@echo "make check               Run tests, typechecking, and package checks"
	@echo "make verify-git-install  Verify an isolated immutable Git package install"

apply:
	mkdir -p "$(PI_EXTENSIONS_DIR)"
	ln -sfn "$(CURDIR)" "$(PI_EXTENSIONS_DIR)/watch-loop"
	$(MAKE) verify-apply
	@echo "Restart Pi after first linking; use /reload for later source changes."

verify-apply:
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/watch-loop")" = "$(CURDIR)"

test:
	npm test

typecheck:
	npm run typecheck

check:
	npm run check

verify-git-install:
	npm run verify:git-install
