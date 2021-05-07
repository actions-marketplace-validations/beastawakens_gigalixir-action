.PHONY: all build release

all: release

release:
	npm run package
	git commit -a -m $(VERSION)
	git tag $(VERSION) -m $(VERSION)
	git push origin refs/tags/$(VERSION)
	git push