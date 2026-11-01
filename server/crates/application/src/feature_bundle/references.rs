// SPDX-License-Identifier: AGPL-3.0-or-later
use super::{CapturedFeatureBundle, validation::valid_pin};
use myoxus_domain::assistant_package::*;
use myoxus_domain::{database::DatabaseTemplateCoreReference, feature_bundle::*};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeKind {
  Database,
  View,
  Field,
  TaskCore,
  Assistant,
  Input,
  Action,
  DocumentAction,
  Binding,
  Result,
  Context,
  Document,
  Workflow,
  Artwork,
  Group,
}
struct NativeReference<'a> {
  kind: NativeKind,
  identity: String,
  digest: Option<String>,
  key: Option<String>,
  value_type: Option<AssistantValueType>,
  package: Option<&'a AssistantPackageSource>,
  binding: Option<&'a AssistantValueBinding>,
  project_template: Option<&'a str>,
}

fn native_reference<'a>(
  bundle: &'a CapturedFeatureBundle,
  reference: &FeatureNativeReference,
) -> Result<NativeReference<'a>, String> {
  let component = bundle
    .manifest
    .components
    .iter()
    .find(|component| component.id == reference.component)
    .ok_or_else(|| format!("missing component {}", reference.component))?;
  let mut resolved = NativeReference {
    kind: NativeKind::Assistant,
    identity: reference.export.clone(),
    digest: None,
    key: reference.key.clone(),
    value_type: None,
    package: None,
    binding: None,
    project_template: None,
  };
  match component.kind {
    FeatureComponentKind::DatabaseCatalog => {
      let sources = bundle
        .databases
        .get(&component.id)
        .ok_or("Database component was not decoded")?;
      let definition = sources
        .definitions
        .iter()
        .find(|definition| format!("{}@{}", definition.id, definition.version) == reference.export)
        .ok_or("unavailable native Database export")?;
      resolved.kind = match reference.key.as_deref() {
        None => NativeKind::Database,
        Some(key) if key.starts_with("view/") => {
          let key = &key[5..];
          if definition.variants.iter().any(|variant| {
            !variant
              .spec
              .to_manifest()
              .is_ok_and(|manifest| manifest.views.iter().any(|view| view.key == key))
          }) {
            return Err("native View key is unavailable in a supported variant".into());
          }
          NativeKind::View
        }
        Some(key) if key.starts_with("field/") => {
          let key = &key[6..];
          if definition
            .variants
            .iter()
            .any(|variant| !variant.spec.fields.iter().any(|field| field.key == key))
          {
            return Err("native Field key is unavailable in a supported variant".into());
          }
          NativeKind::Field
        }
        _ => return Err("unsupported native Database export key".into()),
      };
    }
    FeatureComponentKind::AssistantCatalog => {
      let sources = bundle
        .assistants
        .get(&component.id)
        .ok_or("assistant component was not decoded")?;
      let (package, _) = sources
        .definitions
        .iter()
        .find(|(package, _)| format!("{}@{}", package.id, package.version) == reference.export)
        .ok_or("unavailable native assistant export")?;
      resolved.package = Some(package);
      match reference.key.as_deref() {
        None => {}
        Some(key) if key.starts_with("input/") => {
          let input = package
            .inputs
            .iter()
            .find(|input| input.id == key[6..])
            .ok_or("unavailable native assistant input")?;
          resolved.kind = NativeKind::Input;
          resolved.value_type = Some(input.value_type);
        }
        Some(key) if key.starts_with("component/") => {
          let mut parts = key[10..].split('/');
          let id = parts.next().ok_or("missing native action key")?;
          let action = package
            .components
            .iter()
            .find(|action| action.id == id)
            .ok_or("unavailable native assistant action")?;
          if parts.clone().next() == Some("result") {
            parts.next();
            let result = parts.next().ok_or("missing native result key")?;
            if parts.next().is_some() {
              return Err("invalid native result key".into());
            }
            resolved.value_type = Some(match (&action.action, result) {
              (AssistantNativeAction::CreateDatabaseFromDefinition { .. }, "database") => {
                AssistantValueType::DatabaseDestination
              }
              (AssistantNativeAction::CreateWorkingDocument { .. }, "document") => AssistantValueType::Document,
              _ => return Err("unsupported native result endpoint".into()),
            });
            resolved.kind = NativeKind::Result;
            return Ok(resolved);
          }
          let inputs = match &action.action {
            AssistantNativeAction::CreateDatabaseFromDefinition {
              definition_id,
              selected,
              inputs,
            } => {
              resolved.project_template = Some(definition_id);
              if parts.clone().collect::<Vec<_>>() == ["input", "includeComponent"] {
                resolved.kind = NativeKind::Binding;
                resolved.binding = Some(selected);
                resolved.value_type = Some(AssistantValueType::Boolean);
                return Ok(resolved);
              }
              inputs
            }
            AssistantNativeAction::PlaceNativeLink { target, folder } => {
              if parts.next() != Some("input") {
                return Err("native placement requires an explicit binding endpoint".into());
              }
              let binding = match parts.next() {
                Some("target") => target,
                Some("folder") => folder,
                _ => return Err("unsupported native placement input".into()),
              };
              if parts.next().is_some() {
                return Err("invalid native placement key".into());
              }
              resolved.value_type = Some(match binding {
                AssistantValueBinding::Result {
                  value: AssistantResultValue::Database,
                  ..
                } => AssistantValueType::DatabaseDestination,
                AssistantValueBinding::Result {
                  value: AssistantResultValue::Document,
                  ..
                } => AssistantValueType::Document,
                AssistantValueBinding::Input { input } => {
                  package
                    .inputs
                    .iter()
                    .find(|candidate| candidate.id == *input)
                    .ok_or("missing placement input")?
                    .value_type
                }
                _ => return Err("unsupported native placement binding".into()),
              });
              resolved.binding = Some(binding);
              resolved.kind = NativeKind::Binding;
              return Ok(resolved);
            }
            AssistantNativeAction::CreateProject {
              template_id, inputs, ..
            } => {
              resolved.project_template = Some(template_id);
              inputs
            }
            AssistantNativeAction::TaskMaintenance { inputs }
            | AssistantNativeAction::ConfigureTaskPreparation { inputs }
            | AssistantNativeAction::CreateWorkspace { inputs }
            | AssistantNativeAction::TaskHandover { inputs }
            | AssistantNativeAction::RequestDocumentReview { inputs }
            | AssistantNativeAction::CreateTaskFromDocument { inputs } => inputs,
            AssistantNativeAction::InspectTaskContent { tasks } => {
              if parts.next() != Some("input") || parts.next() != Some("tasks") || parts.next().is_some() {
                return Err("unsupported native inspection export key".into());
              }
              resolved.kind = NativeKind::Binding;
              resolved.binding = Some(tasks);
              resolved.value_type = Some(AssistantValueType::TaskReferences);
              return Ok(resolved);
            }
            AssistantNativeAction::ApplyTaskCorrections { .. } => {
              if parts.next().is_some() {
                return Err("correction proposal bindings belong to the typed workflow".into());
              }
              resolved.kind = NativeKind::Action;
              return Ok(resolved);
            }
            AssistantNativeAction::CreateLinkedDocument { variables, .. } => {
              resolved.kind = NativeKind::DocumentAction;
              if let Some(section) = parts.next() {
                if section != "variable" {
                  return Err("unsupported native row content export key".into());
                }
                let name = parts.next().ok_or("missing row content variable")?;
                if parts.next().is_some() {
                  return Err("invalid row content variable key".into());
                }
                let binding = variables.get(name).ok_or("unknown row content variable")?;
                let AssistantValueBinding::Input { input } = binding else {
                  return Err("unsupported row content variable binding".into());
                };
                resolved.kind = NativeKind::Binding;
                resolved.binding = Some(binding);
                resolved.value_type = package
                  .inputs
                  .iter()
                  .find(|candidate| candidate.id == *input)
                  .map(|input| input.value_type);
              }
              return Ok(resolved);
            }
            AssistantNativeAction::CreateDocument {
              selected,
              folder,
              variables,
            }
            | AssistantNativeAction::CreateWorkingDocument {
              selected,
              folder,
              variables,
            } => {
              resolved.kind = NativeKind::DocumentAction;
              if let Some(section) = parts.next() {
                if section != "variable" {
                  return Err("unsupported native document component export key".into());
                }
                let name = parts.next().ok_or("missing document variable")?;
                if parts.next().is_some() {
                  return Err("invalid document variable key".into());
                }
                let binding = match name {
                  "selected" => selected,
                  "folder" => folder,
                  _ => variables.get(name).ok_or("unknown document variable")?,
                };
                resolved.binding = Some(binding);
                resolved.kind = NativeKind::Binding;
                resolved.value_type = match binding {
                  AssistantValueBinding::Input { input } => package
                    .inputs
                    .iter()
                    .find(|candidate| candidate.id == *input)
                    .map(|input| input.value_type),
                  AssistantValueBinding::Context {
                    value: AssistantContextValue::Database,
                  } => Some(AssistantValueType::DatabaseDestination),
                  AssistantValueBinding::Context {
                    value: AssistantContextValue::Row,
                  } => Some(AssistantValueType::Row),
                  _ => return Err("unsupported document variable binding".into()),
                };
              }
              return Ok(resolved);
            }
          };
          resolved.kind = NativeKind::Action;
          if let Some(section) = parts.next() {
            if section != "input" {
              return Err("unsupported native action export key".into());
            }
            let target = parts.next().ok_or("missing native action input target")?;
            let target: AssistantInputTarget = serde_json::from_value(serde_json::Value::String(target.to_string()))
              .map_err(|_| "unsupported native action input target")?;
            resolved.binding = Some(inputs.get(&target).ok_or("native action input is unbound")?);
            resolved.kind = NativeKind::Binding;
            if let Some(AssistantValueBinding::Input { input }) = resolved.binding {
              resolved.value_type = Some(
                package
                  .inputs
                  .iter()
                  .find(|candidate| candidate.id == *input)
                  .ok_or("native action refers to missing input")?
                  .value_type,
              );
            }
          }
          if parts.next().is_some() {
            return Err("unsupported native action export key".into());
          }
        }
        Some(key) if key.starts_with("context/") => {
          if package.contexts != [AssistantPackageContext::TaskContainerAssistance] {
            return Err("unsupported native assistant context endpoint".into());
          }
          resolved.kind = NativeKind::Context;
          resolved.value_type = Some(match key {
            "context/database" => AssistantValueType::DatabaseDestination,
            "context/row" => AssistantValueType::Row,
            _ => return Err("unsupported native context key".into()),
          });
        }
        Some(key) if key.starts_with("group/") => {
          let mut parts = key[6..].split('/');
          let step_id = parts.next().ok_or("missing presentation step key")?;
          let group_id = parts.next().ok_or("missing presentation group key")?;
          if parts.next().is_some()
            || !package
              .presentation
              .steps
              .iter()
              .chain(package.presentation.guided_help.iter())
              .any(|step| step.id == step_id && step.groups.iter().any(|group| group.id == group_id))
          {
            return Err("unavailable native presentation group".into());
          }
          resolved.kind = NativeKind::Group;
        }
        _ => return Err("unsupported native assistant export key".into()),
      }
    }
    FeatureComponentKind::TaskCore | FeatureComponentKind::DocumentTemplate | FeatureComponentKind::Workflow => {
      resolved.digest = Some(component.sha256.clone());
      let identity = component
        .native_identity
        .as_ref()
        .ok_or("missing native source identity")?;
      if reference.export != format!("{}@{}", identity.id, identity.version) || reference.key.is_some() {
        return Err("native source export identity/key mismatch".into());
      }
      resolved.kind = if component.kind == FeatureComponentKind::TaskCore {
        NativeKind::TaskCore
      } else if component.kind == FeatureComponentKind::Workflow {
        NativeKind::Workflow
      } else {
        NativeKind::Document
      };
    }
    FeatureComponentKind::Artwork => {
      if reference.export != component.id || reference.key.is_some() {
        return Err("Artwork export identity/key mismatch".into());
      }
      resolved.kind = NativeKind::Artwork;
    }
  }
  Ok(resolved)
}

fn target_reference<'a>(
  bundle: &'a CapturedFeatureBundle,
  target: &FeatureReference,
  platform: &'a [CapturedFeatureBundle],
) -> Result<NativeReference<'a>, String> {
  match target {
    FeatureReference::Local { reference } => native_reference(bundle, reference),
    FeatureReference::Platform { bundle: pin, export } => {
      if !valid_pin(pin) {
        return Err("invalid platform export pin".into());
      }
      let mut matches = platform.iter().filter(|candidate| candidate.pin() == *pin);
      let source = matches.next().ok_or("pinned platform export provider unavailable")?;
      if matches.next().is_some() {
        return Err("ambiguous platform export provider".into());
      }
      let export = source
        .manifest
        .exports
        .iter()
        .find(|candidate| candidate.id == *export)
        .ok_or("pinned platform export unavailable")?;
      native_reference(source, &export.source)
    }
  }
}

/// Resolve wrapper links against real native exports and existing bindings.
/// A link may assert a native reference, but cannot change an action or invent
/// a capability its native package validator does not support.
pub fn validate_feature_references(
  bundle: &CapturedFeatureBundle,
  platform: &[CapturedFeatureBundle],
) -> Result<(), String> {
  for export in &bundle.manifest.exports {
    let native =
      native_reference(bundle, &export.source).map_err(|message| format!("export {}: {message}", export.id))?;
    if export.document.is_some() && native.kind != NativeKind::Document {
      return Err(format!(
        "export {} declares document policy on a foreign native kind",
        export.id
      ));
    }
    if !export.contexts.is_empty()
      && (native.kind != NativeKind::Assistant
        || export
          .contexts
          .iter()
          .any(|context| !native.package.is_some_and(|package| package.contexts.contains(context))))
    {
      return Err(format!("export {} has unsupported native offering contexts", export.id));
    }
    let mut contexts = Vec::new();
    for context in &export.contexts {
      if contexts.contains(context) {
        return Err(format!("export {} duplicates an offering context", export.id));
      }
      contexts.push(*context);
    }
  }
  let mut links = std::collections::BTreeSet::new();
  for link in &bundle.manifest.links {
    let (from, to) = match link {
      FeatureLink::Workflow { from, to }
      | FeatureLink::TaskCore { from, to }
      | FeatureLink::Schema { from, to }
      | FeatureLink::View { from, to }
      | FeatureLink::DocumentComponent { from, to }
      | FeatureLink::DocumentSource { from, to }
      | FeatureLink::Artwork { from, to }
      | FeatureLink::Input { from, to, .. }
      | FeatureLink::Context { from, to, .. }
      | FeatureLink::PriorResult { from, to, .. } => (from, to),
    };
    if !links.insert(serde_json::to_string(link).map_err(|error| error.to_string())?) {
      return Err("duplicate Feature Bundle link".into());
    }
    let source = native_reference(bundle, from)?;
    let target = target_reference(bundle, to, platform)?;
    let valid = match link {
      FeatureLink::Workflow {from,to} => {
        if source.kind!=NativeKind::Assistant || target.kind!=NativeKind::Workflow {false} else {
          let (provider,component)=super::artwork_presentation::target_component(bundle,to,platform)?;
          let workflow=provider.workflows.get(&component.id).ok_or("missing decoded workflow")?;
          super::workflows::validate_package_workflow(workflow,source.package.ok_or("missing workflow package")?)?;
          from.key.is_none()
        }
      }
      FeatureLink::TaskCore {..} => {
        if source.kind != NativeKind::Database || target.kind != NativeKind::TaskCore { false } else {
          let definition = bundle.databases.get(&from.component).and_then(|sources| sources.definitions.iter().find(|definition| format!("{}@{}",definition.id,definition.version) == from.export)).ok_or("native Task core source missing")?;
          definition.task_core.as_ref().is_some_and(|core| target.identity == format!("{}@{}",core.id,core.version) && target.digest.as_deref() == Some(core.sha256.as_str()))
        }
      }
      FeatureLink::Schema {..} => source.kind == NativeKind::Action && target.kind == NativeKind::Database && source.project_template.is_some_and(|id| target.identity.rsplit_once('@').is_some_and(|(native_id,_)| id == native_id)),
      FeatureLink::View {..} => source.kind == NativeKind::Input && target.kind == NativeKind::View && source.package.is_some_and(|package| package.inputs.iter().any(|input| from.key.as_deref() == Some(&format!("input/{}",input.id)) && input.target == AssistantInputTarget::InitialView && input.choices.iter().any(|choice| matches!(&choice.value,AssistantValue::Choice(value) if target.key.as_deref() == Some(&format!("view/{value}")))))),
      FeatureLink::Artwork {..} => source.kind == NativeKind::Group && target.kind == NativeKind::Artwork,
      FeatureLink::Input {value_type,..} => source.kind == NativeKind::Binding && target.kind == NativeKind::Input && source.identity == target.identity && source.value_type == Some(*value_type) && target.value_type == Some(*value_type) && matches!(source.binding,Some(AssistantValueBinding::Input {input}) if target.key.as_deref() == Some(&format!("input/{input}"))),
      FeatureLink::DocumentComponent {..} => source.kind == NativeKind::DocumentAction && target.kind == NativeKind::Document && source.package.is_some_and(|package| package.contexts.iter().any(|context|matches!(context,AssistantPackageContext::ProjectCreation|AssistantPackageContext::WorkspaceCreation|AssistantPackageContext::TaskContainerAssistance))),
      FeatureLink::DocumentSource {..} => source.kind == NativeKind::Group && target.kind == NativeKind::Document && source.package.is_some_and(|package| package.contexts.iter().any(|context|matches!(context,AssistantPackageContext::ProjectCreation|AssistantPackageContext::WorkspaceCreation))),
      // Context endpoints bind only the admitted native Task-container target.
      FeatureLink::Context {value_type,..} => source.kind==NativeKind::Binding && target.kind==NativeKind::Context
        && source.identity==target.identity && source.value_type==Some(*value_type) && target.value_type==Some(*value_type)
        && matches!((source.binding,target.key.as_deref()),(Some(AssistantValueBinding::Context{value:AssistantContextValue::Database}),Some("context/database"))|(Some(AssistantValueBinding::Context{value:AssistantContextValue::Row}),Some("context/row"))),
      // Placement consumes only an earlier, receipt-acknowledged native result.
      FeatureLink::PriorResult {value_type,..} => source.kind==NativeKind::Binding && target.kind==NativeKind::Result && source.identity==target.identity && source.value_type==Some(*value_type) && target.value_type==Some(*value_type) && matches!(source.binding,Some(AssistantValueBinding::Result{component,value}) if target.key.as_deref()==Some(&format!("component/{component}/result/{}",match value {AssistantResultValue::Database=>"database",AssistantResultValue::Document=>"document",_=>"unsupported"}))),
    };
    if !valid {
      return Err(format!(
        "unsupported or incompatible native link from {} {}",
        from.component, from.export
      ));
    }
  }
  for (component_id, sources) in &bundle.assistants {
    for (package, _) in &sources.definitions {
      for child in &package.components {
        if !matches!(
          child.action,
          AssistantNativeAction::CreateDocument { .. } | AssistantNativeAction::CreateWorkingDocument { .. }
        ) {
          continue;
        }
        let export = format!("{}@{}", package.id, package.version);
        let key = format!("component/{}", child.id);
        let count = bundle
          .manifest
          .links
          .iter()
          .filter(|link| {
            matches!(link,
          FeatureLink::DocumentComponent { from, .. } if from.component == *component_id
            && from.export == export && from.key.as_deref() == Some(key.as_str()))
          })
          .count();
        if count != 1 {
          return Err("native document component requires exactly one delivery link".into());
        }
      }
    }
  }
  Ok(())
}

/// Resolve only an explicitly pinned platform Task core for this exact native
/// definition. The decoder receives its bytes without acquiring filesystem or
/// bundle-selection policy. A missing declaration never authorizes ambient I/O.
pub fn resolve_feature_task_core(
  links: &[FeatureLink],
  from_component_id: &str,
  definition_id: &str,
  definition_version: &str,
  core: &DatabaseTemplateCoreReference,
  platform: &[CapturedFeatureBundle],
) -> Result<Option<Vec<u8>>, String> {
  let native_export = format!("{definition_id}@{definition_version}");
  let mut candidates = links.iter().filter_map(|link| match link {
    FeatureLink::TaskCore { from, to }
      if from.component == from_component_id && from.export == native_export && from.key.is_none() =>
    {
      Some(to)
    }
    _ => None,
  });
  let Some(target) = candidates.next() else {
    return Ok(None);
  };
  if candidates.next().is_some() {
    return Err(format!("ambiguous Task core dependency for {native_export}"));
  }
  let FeatureReference::Platform { bundle, export } = target else {
    // Local assertions supply no external decoder bytes. Complete reference
    // admission checks the actual local component identity and native hash.
    return Ok(None);
  };
  if !valid_pin(bundle) {
    return Err(format!("invalid platform pin for {native_export}"));
  }
  let mut providers = platform.iter().filter(|candidate| candidate.pin() == *bundle);
  let source = providers.next().ok_or_else(|| {
    format!(
      "platform bundle {} {} is unavailable for {native_export}",
      bundle.id, bundle.version
    )
  })?;
  if providers.next().is_some() {
    return Err("ambiguous platform bundle pin".into());
  }
  let exported = source
    .manifest
    .exports
    .iter()
    .find(|entry| entry.id == *export)
    .ok_or_else(|| format!("platform export {export} is unavailable"))?;
  let component = source
    .manifest
    .components
    .iter()
    .find(|entry| entry.id == exported.source.component)
    .ok_or("platform export component is unavailable")?;
  let expected = FeatureBundleIdentity {
    id: core.id.clone(),
    version: core.version.clone(),
  };
  if component.kind != FeatureComponentKind::TaskCore
    || component.native_identity.as_ref() != Some(&expected)
    || component.sha256 != core.sha256
    || exported.source.export != format!("{}@{}", core.id, core.version)
    || exported.source.key.is_some()
  {
    return Err(format!(
      "platform export {export} does not match the pinned native Task core"
    ));
  }
  let bytes = source
    .files
    .get(&component.path)
    .ok_or("platform Task core bytes unavailable")?;
  if format!("{:x}", Sha256::digest(bytes)) != core.sha256 {
    return Err("platform Task core SHA-256 mismatch".into());
  }
  Ok(Some(bytes.clone()))
}
