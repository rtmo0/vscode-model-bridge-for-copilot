# Releasing

The extension uses the same publisher identity as the sibling MongoDB extension:

- Marketplace publisher: `samarin-aa-aka-rtm00`
- Repository: `rtmo0/vscode-antropic-for-copilot`

## Create a release

1. Update `version` in `package.json` and `package-lock.json`.
2. Run `npm ci`, `npm run check`, `npm run compile`, `npm run test:smoke`, and `npm run package:vsix`.
3. Commit the version change to `main`.
4. Create and push a matching tag, for example `v0.1.0`.

The release workflow verifies that the tag matches the package version, builds a VSIX, creates a GitHub Release, and uploads the VSIX as both a release asset and workflow artifact.

Marketplace publication can be performed with the packaged VSIX under the `samarin-aa-aka-rtm00` publisher after configuring the publisher credentials outside this repository.
