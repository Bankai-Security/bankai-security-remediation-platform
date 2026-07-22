import { describe, expect, it } from "vitest";
import { extractFailingFilePaths } from "./log-parser.js";

describe("extractFailingFilePaths", () => {
  it("resolves a Python traceback (absolute runner path) against the repo tree", () => {
    const log = [
      'Traceback (most recent call last):',
      '  File "/home/runner/work/repo/repo/src/utils/parser.py", line 42, in parse',
      '    raise ValueError("bad")',
      "ValueError: bad",
    ].join("\n");
    const tree = new Set(["src/utils/parser.py", "src/utils/other.py"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["src/utils/parser.py"]);
  });

  it("resolves a pytest short summary line", () => {
    const log = "FAILED tests/test_parser.py::test_parse_empty - AssertionError: assert 1 == 2";
    const tree = new Set(["tests/test_parser.py"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["tests/test_parser.py"]);
  });

  it("resolves a Jest FAIL header and a stack-frame path", () => {
    const log = [
      "FAIL src/utils/parser.test.ts",
      "  ● parser > handles empty input",
      "",
      "    at Object.<anonymous> (src/utils/parser.ts:10:5)",
    ].join("\n");
    const tree = new Set(["src/utils/parser.test.ts", "src/utils/parser.ts"]);
    const result = extractFailingFilePaths(log, tree);
    expect(result).toContain("src/utils/parser.test.ts");
    expect(result).toContain("src/utils/parser.ts");
  });

  it("resolves a TypeScript compiler diagnostic", () => {
    const log = "src/utils/parser.ts(10,5): error TS2345: Argument of type 'string' is not assignable to type 'number'.";
    const tree = new Set(["src/utils/parser.ts"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["src/utils/parser.ts"]);
  });

  it("resolves Maven/Java compiler and stack-frame paths", () => {
    const log = [
      "[ERROR] src/main/java/com/example/Parser.java:[42,10] error: cannot find symbol",
      "  at com.example.ParserTest.testParse(ParserTest.java:15)",
    ].join("\n");
    const tree = new Set(["src/main/java/com/example/Parser.java", "src/test/java/com/example/ParserTest.java"]);
    const result = extractFailingFilePaths(log, tree);
    expect(result).toContain("src/main/java/com/example/Parser.java");
    expect(result).toContain("src/test/java/com/example/ParserTest.java");
  });

  it("resolves Go build errors and test failures", () => {
    const log = [
      "--- FAIL: TestParse (0.00s)",
      "    parser_test.go:15: expected 1, got 2",
      "# example.com/pkg",
      "./pkg/parser.go:10:2: undefined: foo",
    ].join("\n");
    const tree = new Set(["pkg/parser_test.go", "pkg/parser.go"]);
    const result = extractFailingFilePaths(log, tree);
    expect(result).toContain("pkg/parser_test.go");
    expect(result).toContain("pkg/parser.go");
  });

  it("resolves a Rust panic location", () => {
    const log = "thread 'tests::test_parse' panicked at 'assertion failed', src/lib.rs:10:5";
    const tree = new Set(["src/lib.rs"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["src/lib.rs"]);
  });

  it("resolves a .NET stack-frame path", () => {
    const log = "   at Namespace.ParserTests.TestParse() in /home/runner/work/repo/repo/tests/ParserTests.cs:line 42";
    const tree = new Set(["tests/ParserTests.cs"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["tests/ParserTests.cs"]);
  });

  it("resolves a C/C++ compiler diagnostic", () => {
    const log = "src/parser.cpp:10:5: error: expected ';' before '}' token";
    const tree = new Set(["src/parser.cpp"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["src/parser.cpp"]);
  });

  it("resolves a PHPUnit failure path", () => {
    const log = [
      "1) ParserTest::testParse",
      "Failed asserting that false is true.",
      "",
      "/home/runner/work/repo/repo/tests/ParserTest.php:42",
    ].join("\n");
    const tree = new Set(["tests/ParserTest.php"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["tests/ParserTest.php"]);
  });

  it("resolves an RSpec failure path", () => {
    const log = "     # ./spec/parser_spec.rb:10:in `block (2 levels) in <top (required)>'";
    const tree = new Set(["spec/parser_spec.rb"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["spec/parser_spec.rb"]);
  });

  it("drops path-shaped matches that aren't real files in this repo's tree", () => {
    const log = 'File "/usr/lib/python3.11/unittest/case.py", line 42, in run';
    const tree = new Set(["src/utils/parser.py"]);
    expect(extractFailingFilePaths(log, tree)).toEqual([]);
  });

  it("dedupes a path mentioned multiple times across different log lines", () => {
    const log = ["thread 'a' panicked at 'x', src/lib.rs:5:1", "-->  src/lib.rs:5:1"].join("\n");
    const tree = new Set(["src/lib.rs"]);
    expect(extractFailingFilePaths(log, tree)).toEqual(["src/lib.rs"]);
  });

  it("returns an empty array for a log with no recognizable file references", () => {
    const log = "Build succeeded.\nNo errors found.";
    const tree = new Set(["src/lib.rs"]);
    expect(extractFailingFilePaths(log, tree)).toEqual([]);
  });
});
