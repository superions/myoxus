fn main() {
  // Only run napi_build setup when the "napi" feature is enabled.
  // napi-build itself is an optional build-dep gated on the napi feature.
  #[cfg(feature = "napi")]
  napi_build::setup();
}
