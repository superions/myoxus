cask "myoxus" do
  arch arm: "arm64", intel: "x64"

  version "0.42.1"
  sha256 arm: "dcf6f381eacc2de1d5e85ea9437fbb452d0cb9da4c8b216670ac63065698fc91",
         intel: "ac88320632a51db7a070017ccfedb4862beedfabc2fef048cf9a58dce40669be"

  url "https://github.com/superions/myoxus/releases/download/macos-client-v0.42.1/myoxus-0.42.1-stable-macos-#{arch}.dmg"
  name "Myoxus"
  desc "Collaborative workspace"
  homepage "https://github.com/superions/myoxus"

  depends_on :macos

  app "Myoxus.app"
end
