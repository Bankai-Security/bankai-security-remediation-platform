import { describe, expect, it } from "vitest";
import { tryApplyDependencyVersionFix } from "./dependency-fix.js";

describe("tryApplyDependencyVersionFix", () => {
  it("updates a requirements.txt vulnerable package and removes duplicate stale pins", () => {
    const fix = tryApplyDependencyVersionFix({
      filePath: "backend/requirements.txt",
      fileContent: ["flask==3.0.0", "pytest==7.1.2", "requests==2.32.0", "pytest==7.2.0", ""].join("\n"),
      affectedPackages: "pytest",
      fixedVersions: "9.0.3",
    });

    expect(fix).toEqual({
      fixedContent: ["flask==3.0.0", "pytest==9.0.3", "requests==2.32.0", ""].join("\n"),
      summary: "Updated pytest to 9.0.3 in backend/requirements.txt and removed duplicate vulnerable pins.",
    });
  });

  it("does not rewrite non-dependency files", () => {
    const fix = tryApplyDependencyVersionFix({
      filePath: "backend/app.py",
      fileContent: "print('hello')\n",
      title: "pytest: vulnerable temporary directory handling",
      affectedPackages: "pytest",
      fixedVersions: "9.0.3",
    });

    expect(fix).toBeNull();
  });

  it("infers a requirements package from advisory titles when scanner package metadata is missing", () => {
    const fix = tryApplyDependencyVersionFix({
      filePath: "backend/requirements.txt",
      fileContent: ["jinja2==3.1.2", "starlette==0.36.3", ""].join("\n"),
      title: "jinja2: HTML attribute injection when passing user input as keys to xmlattr filter",
      affectedPackages: null,
      fixedVersions: "3.1.3",
    });

    expect(fix).toEqual({
      fixedContent: ["jinja2==3.1.3", "starlette==0.36.3", ""].join("\n"),
      summary: "Updated jinja2 to 3.1.3 in backend/requirements.txt and removed duplicate vulnerable pins.",
    });
  });
});
