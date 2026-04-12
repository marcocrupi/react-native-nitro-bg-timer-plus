# Contributing

Contributions are always welcome, no matter how large or small!

We want this community to be friendly and respectful to each other. Please follow it in all your interactions with the project. Before contributing, please read the [code of conduct](./CODE_OF_CONDUCT.md).

## Development workflow

This project is a monorepo managed using [Yarn workspaces](https://yarnpkg.com/features/workspaces). It contains the following packages:

- The library package in the root directory.
- An example app in the `example/` directory.

To get started with the project, run `yarn` in the root directory to install the required dependencies for each package:

```sh
yarn
```

> This project uses [Yarn 4](https://yarnpkg.com/) with workspaces, configured via `.yarnrc.yml`. Please use `yarn` and not [`npm`](https://github.com/npm/cli) for development: npm would generate a `package-lock.json` alongside the existing `yarn.lock`, diverging dependency resolution across contributors. Yarn 4 also enforces stricter peer dependency checks that npm silently ignores.

This project uses Nitro Modules. If you're not familiar with how Nitro works, make sure to check the [Nitro Modules Docs](https://nitro.margelo.com/).

You need to run [Nitrogen](https://nitro.margelo.com/docs/nitrogen) to generate the boilerplate code required for this project. The example app will not build without this step.

Run **Nitrogen** in following cases:

- When you make changes to any `*.nitro.ts` files.
- When running the project for the first time (since the generated files are not committed to the repository).

To invoke **Nitrogen**, use the following command:

```sh
yarn nitrogen
```

The [example app](/example/) demonstrates usage of the library. You need to run it to test any changes you make.

It is configured to use the local version of the library, so any changes you make to the library's source code will be reflected in the example app. Changes to the library's JavaScript code will be reflected in the example app without a rebuild, but native code changes will require a rebuild of the example app.

If you want to use Android Studio or XCode to edit the native code, you can open the `example/android` or `example/ios` directories respectively in those editors. To edit the Objective-C or Swift files, open `example/ios/NitroBgTimerExample.xcworkspace` in XCode and find the source files at `Pods > Development Pods > react-native-nitro-bg-timer-plus`.

To edit the Java or Kotlin files, open `example/android` in Android studio and find the source files at `react-native-nitro-bg-timer-plus` under `Android`.

You can use various commands from the root directory to work with the project.

To start the packager:

```sh
yarn example:start
```

To run the example app on Android:

```sh
yarn example:android
```

To run the example app on iOS:

```sh
yarn example:ios
```

To confirm that the app is running with the new architecture, you can check the Metro logs for a message like this:

```sh
Running "NitroBgTimerExample" with {"fabric":true,"initialProps":{"concurrentRoot":true},"rootTag":1}
```

Note the `"fabric":true` and `"concurrentRoot":true` properties.

Make sure your code passes TypeScript and ESLint. Run the following to verify:

```sh
yarn typecheck
yarn lint
```

To fix formatting errors, run the following:

```sh
yarn lint --fix
```

### Commit message convention

We follow the [conventional commits specification](https://www.conventionalcommits.org/en) for our commit messages:

- `fix`: bug fixes, e.g. fix crash due to deprecated method.
- `feat`: new features, e.g. add new method to the module.
- `refactor`: code refactor, e.g. migrate from class components to hooks.
- `docs`: changes into documentation, e.g. add usage example for the module.
- `test`: adding or updating tests, e.g. add integration tests using detox.
- `chore`: tooling changes, e.g. change CI config.

### Linting

We use [TypeScript](https://www.typescriptlang.org/) for type checking, and [ESLint](https://eslint.org/) with [Prettier](https://prettier.io/) for linting and formatting the code.

### Scripts

The `package.json` file contains various scripts for common tasks:

- `yarn`: setup project by installing dependencies.
- `yarn typecheck`: type-check files with TypeScript.
- `yarn lint`: lint files with ESLint.
- `yarn specs`: compile TypeScript and regenerate Nitro bridge code.
- `yarn nitrogen`: regenerate Nitro bridge code only.
- `yarn example:start`: start the Metro server for the example app.
- `yarn example:android`: run the example app on Android.
- `yarn example:ios`: run the example app on iOS.
- `yarn example:pods`: run `pod install` in `example/ios`.

### Sending a pull request

> **Working on your first pull request?** You can learn how from this _free_ series: [How to Contribute to an Open Source Project on GitHub](https://app.egghead.io/playlists/how-to-contribute-to-an-open-source-project-on-github).

When you're sending a pull request:

- Prefer small pull requests focused on one change.
- Verify that linters and tests are passing.
- Review the documentation to make sure it looks good.
- Follow the pull request template when opening a pull request.
- For pull requests that change the API or implementation, discuss with maintainers first by opening an issue.
