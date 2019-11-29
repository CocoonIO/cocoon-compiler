# Cocoon Compiler

---

Compiler for the Cocoon.io platform. Fetches queued compilations from the Cocoon.io backend and returns the result of the compilation.

## Getting Started

These instructions will get you a copy of the project up and running on your local machine for development and testing purposes. See deployment for notes on how to deploy the project on a live system.

### Prerequisites

#### For Linux

```bash
curl -sL https://deb.nodesource.com/setup_11.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y libcairo2-dev libgif-dev imagemagick libjpeg-dev libpixman-1-dev mongodb
```

#### For MacOs

First, check that Xcode is installed and you have run the initial setup. Then install:

```bash
brew install node
brew install cairo giflib imagemagick jpeg mongodb pixman
```

#### For Windows

```bash
choco install visualstudio2017community visualstudio2017-workload-universal
choco install nodejs
choco install imagemagick mongodb
```

### Installing

Clone the repository.

```bash
git clone git@github.com:CocoonIO/cocoon-compiler.git
```

And install its dependencies:

```bash
npm install
```

## Running the tests

Test for the compiler can be found in its own [repository](https://github.com/CocoonIO/cocoon-compiler-tester/).

### Coding style tests

To inspect the code style of the [source code](src):

```bash
npm run inspect-src
```

## Development

### Glossary

* **Cocoon compiler**: It can refer to the repository itself or the system running the software of the repository.
* **Cocoon service**: A process of the Cocoon compiler.
* **cocoon-api**: Process of the Cocoon compiler responsible for exposing an API where the status of the different processes of the Cocoon compiler can be accessed.
* **cocoon-compiler**: Process of the Cocoon compiler responsible for keeping track, download and compile the compilations it founds in the queue of the Cocoon backend.
* **cocoon-notifier**: Process of the Cocoon compiler responsible for notifying the Cocoon backend about the results of the cocoon-compiler compilations.
* **cocoon-updater**: Process of the Cocoon compiler responsible for synchronizing a S3 bucket containing the private Cordova-based plugins from Cocoon and the Android SDKs with the system.
* **cocoon-compiler-tester**: Repository containing various test for the Cocoon compiler.
* **build.json**: Configuration file used by Cordova to configure the signing parameters.
* **config.json**: Configuration file used by the Cocoon compiler. Contains the code of the compilation, the platforms the compilation will be compiled for, any signing parameters, the location of the config.xml and the source.zip and the cordova-lib version to use.
* **config.xml**: Configuration file used by Cordova that controls many aspects of a Cordova application's behavior.
* **environment**: Value used by the Cocoon compiler to choose from a series of default behaviours. Those values are:
  * **develop**: Like testing, but doesn't clean the workspace directory after each compilation.
  * **production**: Uses the sources for products in production that are being used by the clients of Cocoon.io.
  * **testing**: Uses the sources for products that are being tested and developed that are not being used by the clients of Cocoon.io.
* **source.zip**: Zip file containing a Cordova based project.

## Deployment

To deploy the compiler use the included script [deploy.sh](deploy.sh).

## Built With

* [Typescript](https://www.typescriptlang.org/) - Language
* [TSLint](https://palantir.github.io/tslint/) - Linter
* [Node](https://nodejs.org/) - JavaScript Runtime Environment
* [NPM](http://www.npmjs.com/) - Dependency Management
* [PM2](https://pm2.io/) - Process Manager
* [Commander](https://github.com/tj/commander.js/) - Command-line Interface Solution
* [Express](https://expressjs.com/) - Web Application Framework
* [JSZip](https://stuk.github.io/jszip/) - Zip Management Library

## Versioning

We use [SemVer](http://semver.org/) for versioning.

## Authors

* **Imanol Martín** - *Initial work* - [keianhzo](https://github.com/keianhzo)
* **Jorge Domínguez** - *Current* - [BlueSialia](https://github.com/BlueSialia)
