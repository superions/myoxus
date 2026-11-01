// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import { generateSchema } from "./codegen";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDirectory = join(packageRoot, "src/schemas/bpmn-2_0");
const temporary = await mkdtemp(join(tmpdir(), "myoxus-bpmn-codegen-"));
try {
  await generateSchema(
    join(schemaDirectory, "BPMN20.xsd"),
    "definitions",
    temporary,
  );
  for (const name of ["types.ts", "meta.ts"]) {
    const output = await format(await readFile(join(temporary, name), "utf8"), {
      parser: "typescript",
    });
    const target = join(schemaDirectory, "ts-gen", name);
    if (process.argv.includes("--check")) {
      if (output !== (await readFile(target, "utf8"))) {
        throw new Error(`Stale BPMN schema artifact: ${name}`);
      }
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, output);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
