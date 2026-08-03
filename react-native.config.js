// Autolinking descriptor.
//
// Both platform entries are intentionally EMPTY: the defaults already find
// `android/` and the root `*.podspec`. Paths here are resolved relative to the
// package root, so an absolute `sourceDir`/`podspecPath` gets re-joined onto that
// root and silently points nowhere — which makes the module vanish from
// autolinking with no error. VisionCamera's own config is empty for this reason.
module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {},
    },
  },
};
