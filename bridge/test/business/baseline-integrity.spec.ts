import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import ts from "typescript";

// Keep the comparison implementation fixed even when production evolves.
// Transpilation removes formatting/comments; only relocated import specifiers
// are normalized. Manifest hashes were calculated from the GitHub base commit.
it("keeps the deployed baseline executable code unchanged", () => {
  const root = join(__dirname, "../fixtures/pre-pr10");
  const manifest = JSON.parse(
    readFileSync(join(root, "manifest.json"), "utf8")
  );
  expect(manifest.commit).toBe("f3525760157ec33cc61a9df3355e479e4be5fcf2");
  expect(manifest.files).toHaveLength(5);
  for (const file of manifest.files) {
    const canonical = ts
      .transpileModule(readFileSync(join(root, file.path), "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ES2020,
          removeComments: true,
        },
      })
      .outputText.replace(/from "[^"]+"/g, 'from "<relocated>"');
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(
      file.canonicalSha256
    );
  }
});
