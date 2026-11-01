import { PackageList, type PackageName } from "./yarn";

export const PackageToDistribution = new Map<
  PackageName,
  BUILD_CONFIG_TYPE["distribution"]
>([
  ["@myoxus/admin", "admin"],
  ["@myoxus/web", "web"],
  ["@myoxus/electron-renderer", "desktop"],
  ["@myoxus/electron", "desktop"],
  ["@myoxus/mobile", "mobile"],
  ["@myoxus/ios", "ios"],
  ["@myoxus/android", "android"],
]);

export const AliasToPackage = new Map<string, PackageName>([
  ["admin", "@myoxus/admin"],
  ["web", "@myoxus/web"],
  ["electron", "@myoxus/electron"],
  ["desktop", "@myoxus/electron-renderer"],
  ["renderer", "@myoxus/electron-renderer"],
  ["mobile", "@myoxus/mobile"],
  ["ios", "@myoxus/ios"],
  ["android", "@myoxus/android"],
  ["gql", "@myoxus/graphql"],
  ...PackageList.map(
    (pkg) => [pkg.name.split("/").pop()!, pkg.name] as [string, PackageName],
  ),
]);
