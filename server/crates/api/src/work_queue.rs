// SPDX-License-Identifier: AGPL-3.0-or-later
//! Existing Redis queue adapter shared by API and background composition.

pub struct RedisQueueAdapter {
  pub queue: myoxus_worker::RedisQueue,
}

#[async_trait::async_trait]
impl myoxus_application::worker::WorkQueuePort for RedisQueueAdapter {
  async fn add_job(
    &self,
    queue: &str,
    job_name: &str,
    data: serde_json::Value,
    max_attempts: Option<u32>,
    delay_ms: Option<i64>,
  ) -> myoxus_application::auth::AuthResult<String> {
    let opts = myoxus_worker::job::JobOptions {
      delay_ms,
      max_attempts: max_attempts.unwrap_or(3) as i32,
      ..Default::default()
    };
    self
      .queue
      .enqueue(queue, job_name, data, opts)
      .await
      .map_err(|error| myoxus_application::auth::AuthError::Storage(error.to_string()))
  }
}
