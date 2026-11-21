const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEndpoint, resolveQueueUrl } = require("./jenkins-build-request.cjs");

test("uses the standard build endpoint for a parameterless job", () => {
  assert.equal(buildEndpoint("http://localhost:8080/job/PR-4/", false), "http://localhost:8080/job/PR-4/build");
});

test("uses buildWithParameters only when the job declares parameters", () => {
  assert.equal(buildEndpoint("http://localhost:8080/job/deploy/", true), "http://localhost:8080/job/deploy/buildWithParameters");
});

test("resolves an absolute-path queue link against the Jenkins build URL", () => {
  assert.equal(resolveQueueUrl("/queue/item/42/", "http://localhost:8080/job/PR-4/build"), "http://localhost:8080/queue/item/42/");
});
