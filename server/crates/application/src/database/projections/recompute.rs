// SPDX-License-Identifier: AGPL-3.0-or-later
use super::*;

enum RollupNumericValues {
  Empty,
  Numbers(Vec<f64>),
  Currency { currency_code: String, amounts: Vec<f64> },
  Duration(Vec<i64>),
}

impl DatabaseProjectionService {
  #[instrument(skip_all, fields(limit, database_limit, reason))]
  pub async fn recompute_stale_rollups(
    &self,
    workspace_id: Option<WorkspaceId>,
    limit: i64,
    database_limit: i64,
    reason: &str,
  ) -> DatabaseResult<DatabaseRollupRecomputeOutcome> {
    if limit <= 0 || database_limit <= 0 {
      return Err(DatabaseServiceError::new(
        ERR_ROLLUP_CONFIG_INVALID,
        "rollup recompute limits must be positive",
      ));
    }
    debug!(
      workspace_id = ?workspace_id,
      limit,
      database_limit,
      reason,
      "database rollup recompute requested"
    );
    let tasks = self
      .projection_repo
      .list_stale_rollup_projection_tasks(workspace_id, limit, database_limit)
      .await?;
    let mut outcome = DatabaseRollupRecomputeOutcome {
      requested_count: tasks.len() as i64,
      ..Default::default()
    };

    for task in tasks {
      let started_at = Instant::now();
      let aggregate = task.config.aggregate;
      let result = self.recompute_rollup_projection(task).await;
      match result {
        Ok(()) => outcome.recomputed_count += 1,
        Err(error) => {
          outcome.failed_count += 1;
          error!(
            error_code = error.code,
            error = %error,
            aggregate = aggregate.as_str(),
            duration_ms = started_at.elapsed().as_millis() as u64,
            "database rollup recompute failed"
          );
        }
      }
    }

    if outcome.failed_count > 0 {
      warn!(
        workspace_id = ?workspace_id,
        requested = outcome.requested_count,
        recomputed = outcome.recomputed_count,
        failed = outcome.failed_count,
        reason,
        "database rollup recompute: partial failure"
      );
    } else {
      info!(
        workspace_id = ?workspace_id,
        requested = outcome.requested_count,
        recomputed = outcome.recomputed_count,
        reason,
        "database rollup recompute complete"
      );
    }
    Ok(outcome)
  }

  async fn recompute_rollup_projection(&self, task: DatabaseRollupProjectionTask) -> DatabaseResult<()> {
    let started_at = Instant::now();
    let targets = self
      .projection_repo
      .list_rollup_target_values(
        task.row_id,
        task.config.source_relation_field_id,
        task.config.target_field_id,
      )
      .await?;
    let source_hash = Self::rollup_source_hash(&targets)?;
    match Self::compute_rollup_value(&task.config, &targets) {
      Ok(value) => {
        self
          .projection_repo
          .upsert_rollup_projection_value(
            task.database_id,
            task.row_id,
            task.field_id,
            value,
            Some(source_hash),
            DatabaseRollupStaleState::Current,
            None,
            None,
          )
          .await?;
        debug!(
          database_id = %task.database_id,
          row_id = %task.row_id,
          field_id = %task.field_id,
          source_relation_field_id = %task.config.source_relation_field_id,
          target_field_id = %task.config.target_field_id,
          aggregate = task.config.aggregate.as_str(),
          stale_state = DatabaseRollupStaleState::Current.as_str(),
          duration_ms = started_at.elapsed().as_millis() as u64,
          "database rollup projection recomputed"
        );
        Ok(())
      }
      Err(error) => {
        self
          .projection_repo
          .upsert_rollup_projection_value(
            task.database_id,
            task.row_id,
            task.field_id,
            None,
            Some(source_hash),
            DatabaseRollupStaleState::Failed,
            Some(error.code.to_string()),
            Some(error.message.clone()),
          )
          .await?;
        Err(error)
      }
    }
  }

  pub(in crate::database) fn compute_rollup_value(
    config: &DatabaseRollupFieldConfig,
    targets: &[DatabaseRollupTargetValue],
  ) -> DatabaseResult<Option<DatabaseRollupScalarValue>> {
    match config.aggregate {
      DatabaseRollupAggregate::Count => Ok(Some(DatabaseRollupScalarValue::Number(targets.len() as f64))),
      DatabaseRollupAggregate::CountValues => Ok(Some(DatabaseRollupScalarValue::Number(
        targets.iter().filter(|target| target.value.is_some()).count() as f64,
      ))),
      DatabaseRollupAggregate::Sum => {
        Self::compute_numeric_or_currency_rollup(config.empty_value.clone(), targets, |values| values.iter().sum())
      }
      DatabaseRollupAggregate::Average => {
        Self::compute_numeric_or_currency_rollup(config.empty_value.clone(), targets, |values| {
          values.iter().sum::<f64>() / values.len() as f64
        })
      }
      DatabaseRollupAggregate::Min => {
        Self::compute_numeric_or_currency_rollup(config.empty_value.clone(), targets, |values| {
          values.iter().copied().reduce(f64::min).unwrap_or_default()
        })
      }
      DatabaseRollupAggregate::Max => {
        Self::compute_numeric_or_currency_rollup(config.empty_value.clone(), targets, |values| {
          values.iter().copied().reduce(f64::max).unwrap_or_default()
        })
      }
      DatabaseRollupAggregate::Earliest => {
        let dates = Self::rollup_date_values(targets, false)?;
        Ok(
          dates
            .into_iter()
            .min()
            .map(|start| DatabaseRollupScalarValue::Date(DatabaseDateValue { start, end: None }))
            .or_else(|| config.empty_value.clone()),
        )
      }
      DatabaseRollupAggregate::Latest => {
        let dates = Self::rollup_date_values(targets, true)?;
        Ok(
          dates
            .into_iter()
            .max()
            .map(|start| DatabaseRollupScalarValue::Date(DatabaseDateValue { start, end: None }))
            .or_else(|| config.empty_value.clone()),
        )
      }
      DatabaseRollupAggregate::CheckedPercent | DatabaseRollupAggregate::UncheckedPercent => {
        let values = Self::rollup_checkbox_values(targets)?;
        if values.is_empty() {
          return Ok(config.empty_value.clone());
        }
        let checked = values.iter().filter(|value| **value).count() as f64;
        let percentage = if config.aggregate == DatabaseRollupAggregate::CheckedPercent {
          checked / values.len() as f64 * 100.0
        } else {
          (values.len() as f64 - checked) / values.len() as f64 * 100.0
        };
        Ok(Some(DatabaseRollupScalarValue::Number(percentage)))
      }
      DatabaseRollupAggregate::UniqueValues => {
        let values = Self::rollup_unique_values(targets)?;
        if values.is_empty() {
          Ok(config.empty_value.clone())
        } else {
          Ok(Some(DatabaseRollupScalarValue::TextList(values)))
        }
      }
    }
  }

  fn rollup_unique_values(targets: &[DatabaseRollupTargetValue]) -> DatabaseResult<Vec<String>> {
    let mut values = BTreeSet::new();
    for value in targets.iter().filter_map(|target| target.value.as_ref()) {
      match value {
        DatabaseCellValueData::Text(value) => {
          if !value.trim().is_empty() {
            values.insert(value.clone());
          }
        }
        DatabaseCellValueData::RichText(value) => {
          if !value.plain_text.trim().is_empty() {
            values.insert(value.plain_text.clone());
          }
        }
        DatabaseCellValueData::Number(value) | DatabaseCellValueData::Percent(value) if value.is_finite() => {
          values.insert(value.to_string());
        }
        DatabaseCellValueData::Currency(value) if value.amount.is_finite() => {
          values.insert(format!("{} {}", value.amount, value.currency_code));
        }
        DatabaseCellValueData::Duration(value) => {
          values.insert(format!("{} min", value.minutes));
        }
        DatabaseCellValueData::Checkbox(value) => {
          values.insert(value.to_string());
        }
        DatabaseCellValueData::Date(value) => {
          values.insert(match value.end {
            Some(end) => format!("{}/{}", value.start, end),
            None => value.start.to_string(),
          });
        }
        DatabaseCellValueData::DateTime(value) => {
          values.insert(match value.end {
            Some(end) => format!("{}/{}", value.start, end),
            None => value.start.to_rfc3339(),
          });
        }
        DatabaseCellValueData::UniqueId(value) => {
          values.insert(value.display.clone());
        }
        DatabaseCellValueData::Select(value) | DatabaseCellValueData::Status(value) => {
          values.insert(value.clone());
        }
        DatabaseCellValueData::MultiSelect(value) => {
          values.extend(value.iter().cloned());
        }
        DatabaseCellValueData::Tags(value) | DatabaseCellValueData::Users(value) => {
          values.extend(value.iter().map(ToString::to_string));
        }
        DatabaseCellValueData::User(value) => {
          values.insert(value.to_string());
        }
        DatabaseCellValueData::Url(value)
        | DatabaseCellValueData::Email(value)
        | DatabaseCellValueData::Phone(value) => {
          values.insert(value.clone());
        }
        DatabaseCellValueData::CreatedTime(value) | DatabaseCellValueData::UpdatedTime(value) => {
          values.insert(value.to_rfc3339());
        }
        DatabaseCellValueData::CreatedBy(value) | DatabaseCellValueData::UpdatedBy(value) => {
          values.insert(value.to_string());
        }
        DatabaseCellValueData::Files(_)
        | DatabaseCellValueData::Relation(_)
        | DatabaseCellValueData::Rollup(_)
        | DatabaseCellValueData::Formula(_)
        | DatabaseCellValueData::DocumentLink(_) => {
          return Err(DatabaseServiceError::new(
            ERR_ROLLUP_RECOMPUTE_FAILED,
            "unique values rollup encountered an unsupported target value",
          ));
        }
        DatabaseCellValueData::Number(_) | DatabaseCellValueData::Percent(_) | DatabaseCellValueData::Currency(_) => {
          return Err(DatabaseServiceError::new(
            ERR_ROLLUP_RECOMPUTE_FAILED,
            "unique values rollup encountered a non-finite target value",
          ));
        }
      }
    }
    Ok(values.into_iter().collect())
  }

  fn compute_numeric_or_currency_rollup(
    empty_value: Option<DatabaseRollupScalarValue>,
    targets: &[DatabaseRollupTargetValue],
    compute: impl FnOnce(&[f64]) -> f64,
  ) -> DatabaseResult<Option<DatabaseRollupScalarValue>> {
    let values = Self::rollup_number_or_currency_values(targets)?;
    match values {
      RollupNumericValues::Empty => Ok(empty_value),
      RollupNumericValues::Numbers(values) => Ok(Some(DatabaseRollupScalarValue::Number(compute(&values)))),
      RollupNumericValues::Currency { currency_code, amounts } => {
        Ok(Some(DatabaseRollupScalarValue::Currency(DatabaseCurrencyValue {
          amount: compute(&amounts),
          currency_code,
        })))
      }
      RollupNumericValues::Duration(values) => {
        let values = values.iter().map(|value| *value as f64).collect::<Vec<_>>();
        Ok(Some(DatabaseRollupScalarValue::Duration(DatabaseDurationValue {
          minutes: compute(&values).round() as i64,
        })))
      }
    }
  }

  fn rollup_number_or_currency_values(targets: &[DatabaseRollupTargetValue]) -> DatabaseResult<RollupNumericValues> {
    let mut numbers = Vec::new();
    let mut currency_amounts = Vec::new();
    let mut currency_code: Option<String> = None;
    let mut durations = Vec::new();
    for value in targets.iter().filter_map(|target| target.value.as_ref()) {
      match value {
        DatabaseCellValueData::Number(value) | DatabaseCellValueData::Percent(value) if value.is_finite() => {
          if currency_code.is_some() || !durations.is_empty() {
            return Err(DatabaseServiceError::new(
              ERR_ROLLUP_RECOMPUTE_FAILED,
              "rollup numeric aggregate cannot mix number, currency and duration target values",
            ));
          }
          numbers.push(*value);
        }
        DatabaseCellValueData::Currency(value) if value.amount.is_finite() => {
          if !numbers.is_empty() || !durations.is_empty() {
            return Err(DatabaseServiceError::new(
              ERR_ROLLUP_RECOMPUTE_FAILED,
              "rollup numeric aggregate cannot mix number, currency and duration target values",
            ));
          }
          if let Some(existing) = &currency_code {
            if existing != &value.currency_code {
              return Err(DatabaseServiceError::new(
                ERR_ROLLUP_RECOMPUTE_FAILED,
                "rollup money aggregate encountered multiple currencies",
              ));
            }
          } else {
            currency_code = Some(value.currency_code.clone());
          }
          currency_amounts.push(value.amount);
        }
        DatabaseCellValueData::Duration(value) => {
          if !numbers.is_empty() || currency_code.is_some() {
            return Err(DatabaseServiceError::new(
              ERR_ROLLUP_RECOMPUTE_FAILED,
              "rollup numeric aggregate cannot mix number, currency and duration target values",
            ));
          }
          durations.push(value.minutes);
        }
        _ => {
          return Err(DatabaseServiceError::new(
            ERR_ROLLUP_RECOMPUTE_FAILED,
            "rollup number aggregate encountered a non-number target value",
          ));
        }
      }
    }
    if let Some(currency_code) = currency_code {
      Ok(RollupNumericValues::Currency {
        currency_code,
        amounts: currency_amounts,
      })
    } else if !durations.is_empty() {
      Ok(RollupNumericValues::Duration(durations))
    } else if numbers.is_empty() {
      Ok(RollupNumericValues::Empty)
    } else {
      Ok(RollupNumericValues::Numbers(numbers))
    }
  }

  fn rollup_checkbox_values(targets: &[DatabaseRollupTargetValue]) -> DatabaseResult<Vec<bool>> {
    targets
      .iter()
      .filter_map(|target| target.value.as_ref())
      .map(|value| match value {
        DatabaseCellValueData::Checkbox(value) => Ok(*value),
        _ => Err(DatabaseServiceError::new(
          ERR_ROLLUP_RECOMPUTE_FAILED,
          "rollup checkbox aggregate encountered a non-checkbox target value",
        )),
      })
      .collect()
  }

  fn rollup_date_values(targets: &[DatabaseRollupTargetValue], use_range_end: bool) -> DatabaseResult<Vec<NaiveDate>> {
    targets
      .iter()
      .filter_map(|target| target.value.as_ref())
      .map(|value| match value {
        DatabaseCellValueData::Date(value) => {
          if use_range_end {
            Ok(value.end.unwrap_or(value.start))
          } else {
            Ok(value.start)
          }
        }
        DatabaseCellValueData::DateTime(value) => {
          let instant = if use_range_end {
            value.end.unwrap_or(value.start)
          } else {
            value.start
          };
          Ok(instant.date_naive())
        }
        _ => Err(DatabaseServiceError::new(
          ERR_ROLLUP_RECOMPUTE_FAILED,
          "rollup date aggregate encountered a non-date target value",
        )),
      })
      .collect()
  }

  fn rollup_source_hash(targets: &[DatabaseRollupTargetValue]) -> DatabaseResult<String> {
    let bytes = serde_json::to_vec(targets).map_err(|error| {
      DatabaseServiceError::new(
        ERR_ROLLUP_RECOMPUTE_FAILED,
        format!("failed to serialize rollup source snapshot: {error}"),
      )
    })?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
  }

  #[instrument(skip_all, fields(limit, database_limit, reason))]
  pub async fn recompute_stale_formulas(
    &self,
    workspace_id: Option<WorkspaceId>,
    limit: i64,
    database_limit: i64,
    reason: &str,
  ) -> DatabaseResult<DatabaseFormulaRecomputeOutcome> {
    if limit <= 0 || database_limit <= 0 {
      return Err(DatabaseServiceError::new(
        ERR_FORMULA_EVAL_LIMIT_EXCEEDED,
        "formula recompute limits must be positive",
      ));
    }
    debug!(
      workspace_id = ?workspace_id,
      limit,
      database_limit,
      reason,
      "database formula recompute requested"
    );
    let tasks = self
      .projection_repo
      .list_stale_formula_projection_tasks(workspace_id, limit, database_limit)
      .await?;
    let mut outcome = DatabaseFormulaRecomputeOutcome {
      requested_count: tasks.len() as i64,
      ..Default::default()
    };

    for task in tasks {
      let started_at = Instant::now();
      let expression_hash = Self::formula_expression_hash(&task.config.expression);
      let result = self.recompute_formula_projection(task).await;
      match result {
        Ok(()) => outcome.recomputed_count += 1,
        Err(error) => {
          outcome.failed_count += 1;
          error!(
            error_code = error.code,
            error = %error,
            expression_hash,
            duration_ms = started_at.elapsed().as_millis() as u64,
            "database formula recompute failed"
          );
        }
      }
    }

    if outcome.failed_count > 0 {
      warn!(
        workspace_id = ?workspace_id,
        requested = outcome.requested_count,
        recomputed = outcome.recomputed_count,
        failed = outcome.failed_count,
        reason,
        "database formula recompute: partial failure"
      );
    } else {
      info!(
        workspace_id = ?workspace_id,
        requested = outcome.requested_count,
        recomputed = outcome.recomputed_count,
        reason,
        "database formula recompute complete"
      );
    }
    Ok(outcome)
  }

  async fn recompute_formula_projection(&self, task: DatabaseFormulaProjectionTask) -> DatabaseResult<()> {
    let started_at = Instant::now();
    let record = self
      .schema_repo
      .get_database(task.database_id)
      .await?
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "formula database not found"))?;
    let available_fields = record
      .fields
      .iter()
      .filter(|field| field.id != task.field_id)
      .cloned()
      .collect::<Vec<_>>();
    let analysis = analyze_formula(&task.config.expression, task.config.result_type, &available_fields)?;
    let sources = self
      .projection_repo
      .list_formula_source_values(task.row_id, analysis.dependency_field_ids.clone())
      .await?;
    let source_hash = Self::formula_source_hash(&sources)?;
    match evaluate_formula(&analysis.ast, &available_fields, &sources) {
      Ok(value) => {
        self
          .projection_repo
          .upsert_formula_projection_value(
            task.database_id,
            task.row_id,
            task.field_id,
            value,
            Some(source_hash),
            DatabaseFormulaStaleState::Current,
            None,
            None,
          )
          .await?;
        debug!(
          database_id = %task.database_id,
          row_id = %task.row_id,
          field_id = %task.field_id,
          dependency_count = analysis.dependency_field_ids.len(),
          expression_hash = Self::formula_expression_hash(&task.config.expression),
          stale_state = DatabaseFormulaStaleState::Current.as_str(),
          duration_ms = started_at.elapsed().as_millis() as u64,
          "database formula projection recomputed"
        );
        Ok(())
      }
      Err(error) => {
        self
          .projection_repo
          .upsert_formula_projection_value(
            task.database_id,
            task.row_id,
            task.field_id,
            None,
            Some(source_hash),
            DatabaseFormulaStaleState::Failed,
            Some(ERR_FORMULA_RECOMPUTE_FAILED.to_string()),
            Some(error.message.clone()),
          )
          .await?;
        Err(DatabaseServiceError::new(ERR_FORMULA_RECOMPUTE_FAILED, error.message))
      }
    }
  }

  fn formula_expression_hash(expression: &str) -> String {
    let digest = Sha256::digest(expression.as_bytes());
    format!("{digest:x}")
  }

  fn formula_source_hash(sources: &[DatabaseFormulaSourceValue]) -> DatabaseResult<String> {
    let bytes = serde_json::to_vec(sources).map_err(|error| {
      DatabaseServiceError::new(
        ERR_FORMULA_RECOMPUTE_FAILED,
        format!("failed to serialize formula source snapshot: {error}"),
      )
    })?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
  }
}
