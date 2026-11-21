// SPDX-License-Identifier: AGPL-3.0-or-later
use myoxus_domain::repositories::RepoResult;
use std::sync::{Arc, LazyLock};

type Load<T> = Box<dyn FnOnce() -> RepoResult<Arc<T>> + Send + Sync>;

/// Servers supply admitted release inputs at startup. Short-lived consumers can
/// share a fallible first-use capture, including its failure, for one invocation.
#[derive(Debug)]
pub struct FeatureInput<T>(Input<T>);

#[derive(Debug)]
enum Input<T> {
  Ready(Arc<T>),
  Deferred(Arc<LazyLock<RepoResult<Arc<T>>, Load<T>>>),
}

impl<T> From<Arc<T>> for FeatureInput<T> {
  fn from(value: Arc<T>) -> Self {
    Self(Input::Ready(value))
  }
}

impl<T> Clone for FeatureInput<T> {
  fn clone(&self) -> Self {
    Self(match &self.0 {
      Input::Ready(value) => Input::Ready(value.clone()),
      Input::Deferred(value) => Input::Deferred(value.clone()),
    })
  }
}

impl<T> FeatureInput<T> {
  pub fn deferred(load: impl FnOnce() -> RepoResult<Arc<T>> + Send + Sync + 'static) -> Self {
    Self(Input::Deferred(Arc::new(LazyLock::new(Box::new(load)))))
  }

  /// Preserve startup admission when a service only projects an existing input.
  pub fn map<U>(self, project: impl FnOnce(&Arc<T>) -> U + Send + Sync + 'static) -> FeatureInput<U>
  where
    T: Send + Sync + 'static,
  {
    match self.0 {
      Input::Ready(value) => Arc::new(project(&value)).into(),
      Input::Deferred(_) => FeatureInput::deferred(move || Ok(Arc::new(project(self.get()?)))),
    }
  }

  pub fn get(&self) -> RepoResult<&Arc<T>> {
    match &self.0 {
      Input::Ready(value) => Ok(value),
      Input::Deferred(value) => LazyLock::force(value).as_ref().map_err(Clone::clone),
    }
  }
}
