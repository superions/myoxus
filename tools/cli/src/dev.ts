import type { PackageName } from "@myoxus-tools/utils/workspace";

import { Option, PackageSelectorCommand } from "./command";

export class DevCommand extends PackageSelectorCommand {
  static override paths = [["dev"], ["d"]];

  protected override availablePackages: PackageName[] = [
    "@myoxus/web",
    "@myoxus/electron",
    "@myoxus/electron-renderer",
    "@myoxus/mobile",
    "@myoxus/ios",
    "@myoxus/android",
    "@myoxus/admin",
  ];

  protected deps = Option.Boolean("--deps", {
    description: "Run dev with dependencies",
  });

  async execute() {
    const name = await this.getPackage();
    const args = [];

    if (this.deps) {
      args.push("--deps");
    }

    args.push(name, "dev");

    await this.cli.run(args);
  }
}
