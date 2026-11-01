//! Contract inventory test verifying all Copilot endpoints are declared in the inventory.
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct CopilotContractInventory {
  graphql_operations: Vec<OperationSpec>,
  rest_endpoints: Vec<RestSpec>,
}

#[derive(Debug, Deserialize)]
struct OperationSpec {
  operation_name: String,
  operation_type: String,
}

#[derive(Debug, Deserialize)]
struct RestSpec {
  http_method: String,
  resolved_path: Option<String>,
  route_literal: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphqlInventory {
  operations: Vec<GraphqlOperation>,
}

#[derive(Debug, Deserialize)]
struct GraphqlOperation {
  operation_name: String,
  operation_type: String,
}

#[derive(Debug, Deserialize)]
struct RestInventory {
  endpoints: Vec<RestEndpoint>,
}

#[derive(Debug, Deserialize)]
struct RestEndpoint {
  http_method: String,
  resolved_path: Option<String>,
  route_literal: Option<String>,
}

#[test]
fn copilot_seed_inventory_is_backed_by_contract_sources() {
  let seed_raw = myoxus_tests::load_copilot_contract().expect("seed inventory must exist");
  let seed: CopilotContractInventory = serde_json::from_str(&seed_raw).expect("seed inventory must be valid json");

  let graphql_raw = myoxus_tests::load_graphql_inventory().expect("graphql inventory must exist");
  let graphql: GraphqlInventory = serde_json::from_str(&graphql_raw).expect("graphql inventory must be valid json");

  let rest_raw = myoxus_tests::load_rest_inventory().expect("rest inventory must exist");
  let rest: RestInventory = serde_json::from_str(&rest_raw).expect("rest inventory must be valid json");

  for required in &seed.graphql_operations {
    let found = graphql.operations.iter().any(|op| {
      op.operation_name == required.operation_name && op.operation_type.eq_ignore_ascii_case(&required.operation_type)
    });
    assert!(
      found,
      "missing copilot graphql operation in inventory: {} ({})",
      required.operation_name, required.operation_type
    );
  }

  for required in &seed.rest_endpoints {
    let found = rest.endpoints.iter().any(|ep| {
      ep.http_method.eq_ignore_ascii_case(&required.http_method)
        && match (&required.resolved_path, &required.route_literal) {
          (Some(path), _) => ep.resolved_path.as_ref() == Some(path),
          (None, Some(route)) => ep.route_literal.as_ref() == Some(route),
          (None, None) => false,
        }
    });
    assert!(
      found,
      "missing copilot rest endpoint in inventory: method={} path={:?} route={:?}",
      required.http_method, required.resolved_path, required.route_literal
    );
  }
}

#[test]
fn copilot_seed_inventory_contains_expected_surface() {
  let seed_raw = myoxus_tests::load_copilot_contract().expect("seed inventory must exist");
  let seed: CopilotContractInventory = serde_json::from_str(&seed_raw).expect("seed inventory must be valid json");

  assert!(
    seed.graphql_operations.len() >= 40,
    "copilot graphql seed surface unexpectedly small"
  );
  assert!(
    seed.rest_endpoints.len() >= 2,
    "copilot rest seed surface unexpectedly small"
  );

  let must_have = [
    "createCopilotSession",
    "createCopilotMessage",
    "getCopilotSession",
    "getCopilotSessions",
    "listContext",
    "matchContext",
    "getPromptModels",
    "submitAudioTranscription",
  ];
  for operation in must_have {
    assert!(
      seed
        .graphql_operations
        .iter()
        .any(|item| item.operation_name == operation),
      "required copilot operation missing from seed inventory: {operation}"
    );
  }
}
