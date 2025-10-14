/* eslint-disable no-console */
// This script mirrors the logic previously embedded in actions/github-script steps
// It reads the GitHub Action context from the environment and uses @actions/core and @actions/github

const core = require("@actions/core");
const github = require("@actions/github");

function parseProjectUrl(projectUrl) {
  const url = new URL(projectUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length !== 4 ||
    (parts[0] !== "orgs" && parts[0] !== "users") ||
    parts[2] !== "projects"
  ) {
    throw new Error(
      `Bad PROJECT_URL (expect orgs/... or users/...): ${projectUrl}`
    );
  }
  return {
    isOrg: parts[0] === "orgs",
    login: parts[1],
    number: parseInt(parts[3], 10),
  };
}

function sectionFromBody(body, label) {
  const lines = (body || "").split("\n");
  const header = `### ${label}`.toLowerCase();
  let collecting = false;
  const collected = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!collecting) {
      if (lower.trim().startsWith(header)) {
        collecting = true;
      }
      continue;
    }
    if (lower.startsWith("### ")) {
      break;
    }
    collected.push(line);
  }
  const text = collected.join("\n").trim();
  return text.length ? text : null;
}

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN || process.env.PROJECT_TOKEN;
    if (!token) throw new Error("Missing token");
    const octokit = github.getOctokit(token);
    const projectUrl = process.env.PROJECT_URL;
    const { isOrg, login, number } = parseProjectUrl(projectUrl);

    // Check access
    const q = isOrg
      ? `
      query($login: String!, $number: Int!) {
        organization(login: $login) { projectV2(number: $number) { id title } }
      }
    `
      : `
      query($login: String!, $number: Int!) {
        user(login: $login) { projectV2(number: $number) { id title } }
      }
    `;
    const r = await octokit.graphql(q, { login, number });
    const proj = isOrg ? r.organization?.projectV2 : r.user?.projectV2;
    if (!proj)
      throw new Error(
        `Project not found or not visible. login=${login} number=${number}`
      );
    core.info(`Project resolved: id=${proj.id} title="${proj.title}"`);

    // Mapping
    const body = github.context.payload?.issue?.body || "";
    const area = sectionFromBody(body, "Area / Component");
    const effort = sectionFromBody(body, "Effort");
    const impact = sectionFromBody(body, "Impact");
    const proposal = sectionFromBody(body, "Proposed Action");
    const category = sectionFromBody(body, "Category");
    core.info(
      `Parsed sections -> Effort: ${effort} | Category: ${category} | Impact length: ${
        impact?.length || 0
      } | Area: ${area} | Proposal length: ${proposal?.length || 0}`
    );
    core.info(
      `Target project -> ${isOrg ? "org" : "user"}: ${login} #${number}`
    );

    const issueId = github.context.payload?.issue?.node_id;
    if (!issueId) throw new Error("No issue node_id in context");

    const projectQuery = isOrg
      ? `
      query($login: String!, $number: Int!) {
        organization(login: $login) {
          projectV2(number: $number) {
            id
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon { id name dataType }
                ... on ProjectV2SingleSelectField { id name options { id name } }
              }
            }
            items(first: 200) { nodes { id content { ... on Issue { id } } } }
          }
        }
      }
    `
      : `
      query($login: String!, $number: Int!) {
        user(login: $login) {
          projectV2(number: $number) {
            id
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon { id name dataType }
                ... on ProjectV2SingleSelectField { id name options { id name } }
              }
            }
            items(first: 200) { nodes { id content { ... on Issue { id } } } }
          }
        }
      }
    `;
    const projData = await octokit.graphql(projectQuery, { login, number });
    const project = isOrg
      ? projData.organization?.projectV2
      : projData.user?.projectV2;
    if (!project) throw new Error(`Project not found for ${projectUrl}`);

    const findField = (name) =>
      project.fields.nodes.find(
        (f) => f.name.toLowerCase() === name.toLowerCase()
      );
    const effortField = findField("Effort");
    const categoryField = findField("Category");
    const impactField = findField("Impact");
    const areaField = findField("Area / Component");
    const proposalField = findField("Proposed Action");

    let item = project.items.nodes.find((n) => n.content?.id === issueId);
    if (!item) {
      const addRes = await octokit.graphql(
        `
        mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}) {
            item { id }
          }
        }`,
        { projectId: project.id, contentId: issueId }
      );
      item = addRes.addProjectV2ItemById.item;
    }

    const setSingle = async (field, value) => {
      if (!field || !value) return;
      const opt = field.options.find(
        (o) => o.name.toLowerCase() === value.toLowerCase()
      );
      if (!opt) return;
      await octokit.graphql(
        `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input:{
            projectId:$projectId, itemId:$itemId, fieldId:$fieldId,
            value:{ singleSelectOptionId:$optionId }
          }) { clientMutationId }
        }`,
        {
          projectId: project.id,
          itemId: item.id,
          fieldId: field.id,
          optionId: opt.id,
        }
      );
    };

    const setText = async (field, value) => {
      if (!field || !value) return;
      await octokit.graphql(
        `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
          updateProjectV2ItemFieldValue(input:{
            projectId:$projectId, itemId:$itemId, fieldId:$fieldId,
            value:{ text:$text }
          }) { clientMutationId }
        }`,
        {
          projectId: project.id,
          itemId: item.id,
          fieldId: field.id,
          text: value,
        }
      );
    };

    await setSingle(effortField, effort);
    await setSingle(categoryField, category);
    await setText(impactField, impact);
    await setText(areaField, area);
    await setText(proposalField, proposal);
  } catch (e) {
    core.setFailed(e.message || String(e));
  }
}

run();
