function buildEndpoint(jobUrl, hasParameters) {
  return `${jobUrl.replace(/\/$/, "")}/${hasParameters ? "buildWithParameters" : "build"}`;
}

function resolveQueueUrl(location, buildUrl) {
  return new URL(location, buildUrl).toString();
}

module.exports = { buildEndpoint, resolveQueueUrl };
