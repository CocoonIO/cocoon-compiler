# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] - 2018-08-21
### Added
- Support for cordova-android@7.0.0.
- Added hostname to log of a compilation to be able to identify the server of a compilation.
- Added default environment to 'deploy.sh'.
- Added code to safely warn the user about names longer than 40 characters not being accepted on Windows compilation.
- Deregistration of services.
- Added es2017 lib to Typescript.
- Extra error log if there is a problem when platforms and plugins install.

### Changed
- Logger layout has been shortened to reduce log clutter:
  - Previous layout: `[2018-05-04T11:22:33.456] [INFO] cocoon-compiler`
  - Current layout: `20180504T112233 [INFO] cocoon-compiler`
- Use default Java of the system. Let Cordova warn if it's not compatible.
- Increased time it takes to fail before receiving the public IP to avoid errors.
- Updated dependencies.
- Moved Java & Gradle dependency from Builder to AndroidBuilder

### Fixed
- Project directory was being removed when on _develop_ environment.
- Some typos in error messages were corrected.

### Removed
- Removed repetition when setting default options of a service. File "config.json" at the root of the cocoon-compiler project was removed.
- Removed Gulp devDependency and gulpfile.

## [0.14.0] - 2018-05-03
### Added
- Added error codes to public error messages so users can report bugs more accurately.

### Changed
- Changed the way the local tests paths are handled. Now the path inside the config.json file must be specified as relative paths to the location of the config.json. Compiler code has been updated to fit this new approach. Tests branch 2.1.1 must be used.
- Now using the _exportOptionsPlist_ option for the `xcodebuild -exportArchive` process. This creates a folder with tree metadata files and the IPA file, but we only return the IPA.
- Updated dependencies to their latest stable versions.

### Fixed
- Fix error where some zips erred when being decompressed.

### Removed
- Removed error log: "cannot create output dir: null" when the updater syncs.
