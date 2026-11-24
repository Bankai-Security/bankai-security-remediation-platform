function repositoryName(repo) {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error('Connect a GitHub repository to this Bankai project before setting up Jenkins.');
  }
  const [owner, repository] = parts;
  const name = `bankai-${owner}-${repository}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 100);
  return { owner, repository, name };
}

function pipelineUrl(jenkinsUrl, name) {
  return `${jenkinsUrl.replace(/\/$/, '')}/job/${encodeURIComponent(name)}/`;
}

function pipelineConfigXml(owner, repository) {
  return `<?xml version="1.1" encoding="UTF-8"?>
<org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject plugin="workflow-multibranch"><actions/><description>Created by Bankai for ${owner}/${repository}</description><properties/><folderViews class="jenkins.branch.MultiBranchProjectViewHolder"/><healthMetrics/><icon class="jenkins.branch.MetadataActionFolderIcon"/><orphanedItemStrategy class="com.cloudbees.hudson.plugins.folder.computed.DefaultOrphanedItemStrategy"><pruneDeadBranches>true</pruneDeadBranches><daysToKeep>-1</daysToKeep><numToKeep>-1</numToKeep><abortBuilds>true</abortBuilds></orphanedItemStrategy><triggers/><sources class="jenkins.branch.MultiBranchProject$BranchSourceList"><data><jenkins.branch.BranchSource><source class="org.jenkinsci.plugins.github_branch_source.GitHubSCMSource"><id>bankai-${owner}-${repository}</id><repoOwner>${owner}</repoOwner><repository>${repository}</repository><traits><org.jenkinsci.plugins.github__branch__source.BranchDiscoveryTrait><strategyId>3</strategyId></org.jenkinsci.plugins.github__branch__source.BranchDiscoveryTrait><org.jenkinsci.plugins.github__branch__source.OriginPullRequestDiscoveryTrait><strategyId>2</strategyId></org.jenkinsci.plugins.github__branch__source.OriginPullRequestDiscoveryTrait><org.jenkinsci.plugins.github__branch__source.ForkPullRequestDiscoveryTrait><strategyId>1</strategyId><trust class="org.jenkinsci.plugins.github_branch_source.ForkPullRequestDiscoveryTrait$TrustPermission"/></org.jenkinsci.plugins.github__branch__source.ForkPullRequestDiscoveryTrait></traits></source><strategy class="jenkins.branch.DefaultBranchPropertyStrategy"><properties class="empty-list"/></strategy></jenkins.branch.BranchSource></data><owner class="org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject"/></sources><factory class="org.jenkinsci.plugins.workflow.multibranch.WorkflowBranchProjectFactory"><owner class="org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject"/><scriptPath>Jenkinsfile</scriptPath></factory></org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject>`;
}

module.exports = { repositoryName, pipelineUrl, pipelineConfigXml };
