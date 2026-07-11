import StubPage from './StubPage';

export function RemediationWorkflow() {
  return (
    <StubPage
      eyebrow="Workspace"
      title="Remediation Workflow"
      description="The intake → triage → defect → ticket pipeline view isn't built out in this pass. It's next up after New Project."
    />
  );
}

export function Overview() {
  return (
    <StubPage
      eyebrow="Workspace"
      title="Overview"
      description="The KPI dashboard (CVIT totals, SLA trend, severity breakdown) isn't built out in this pass."
    />
  );
}

export function ReportIntake() {
  return (
    <StubPage
      eyebrow="Workspace"
      title="Report Intake"
      description="This is where a newly created project lands to upload its first scan. The upload/processing surface isn't built out in this pass."
    />
  );
}

export function AITriage() {
  return (
    <StubPage
      eyebrow="Workspace"
      title="AI Triage"
      description="The CVIT review table and detail drawer aren't built out in this pass."
    />
  );
}

export function Tickets() {
  return (
    <StubPage
      eyebrow="Workspace"
      title="Tickets"
      description="The Jira ticket kanban/table view isn't built out in this pass."
    />
  );
}

export function Activity() {
  return (
    <StubPage
      eyebrow="Workspace"
      title="Activity"
      description="The audit feed isn't built out in this pass."
    />
  );
}

export function Settings() {
  return (
    <StubPage
      eyebrow="Workspace"
      title="Settings"
      description="Profile, Jira integration, SLA policy, and notification settings aren't built out in this pass."
    />
  );
}
