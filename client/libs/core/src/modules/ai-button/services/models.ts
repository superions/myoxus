import { getPromptModelsQuery } from "@myoxus/graphql";
import { LiveData, Service } from "@myoxus/infra";
import { signal } from "@preact/signals-core";
import {
  createSignalFromObservable,
  type Signal,
} from "@virgultum/editor/shared/utils";

import type { GraphQLService, UserPreferencesService } from "../../server";

export interface AIModel {
  name: string;
  id: string;
  isDefault: boolean;
  reasoningAvailable: boolean;
  supportsVision: boolean;
}

export class AIModelService extends Service {
  modelId: Signal<string | undefined>;

  models: Signal<AIModel[]> = signal([]);
  status = signal<"loading" | "ready" | "empty" | "error">("loading");
  private request = 0;

  /** The displayed server default must also be the literal native request ID.
   * A saved invalid choice is not silently replaced by that default.
   */
  get effectiveModelId() {
    return (
      this.modelId.value ??
      this.models.value.find((model) => model.isDefault)?.id
    );
  }

  get reasoningAvailable() {
    return (
      this.status.value === "ready" &&
      !!this.models.value.find((model) => model.id === this.effectiveModelId)
        ?.reasoningAvailable
    );
  }

  get supportsVision() {
    return (
      this.status.value === "ready" &&
      !!this.models.value.find((model) => model.id === this.effectiveModelId)
        ?.supportsVision
    );
  }

  private readonly modelId$ = LiveData.from(
    this.userPreferencesService.userPreferences$.map(
      (preferences) => preferences?.effectiveValues.aiModelId ?? undefined,
    ),
    undefined,
  );

  constructor(
    private readonly userPreferencesService: UserPreferencesService,
    private readonly gqlService: GraphQLService,
  ) {
    super();

    const { signal: modelId, cleanup } = createSignalFromObservable<
      string | undefined
    >(this.modelId$, undefined);
    this.modelId = modelId;
    this.disposables.push(cleanup);

    void this.reload();
  }

  resetModel = () => {
    void this.userPreferencesService.update({ aiModelId: null });
  };

  setModel = (modelId: string) => {
    if (!this.models.value.some((model) => model.id === modelId)) return;
    void this.userPreferencesService.update({ aiModelId: modelId });
  };

  readonly reload = async () => {
    const request = ++this.request;
    this.status.value = "loading";
    try {
      const models = await this.getModelsByPrompt("Chat With Myoxus AI");
      if (request !== this.request) return;
      if (!models) throw new Error("Model response unavailable");
      this.models.value = models.optionalModels.map((model) => ({
        name: model.name,
        id: model.id,
        isDefault: model.id === models.defaultModel,
        reasoningAvailable: model.reasoningAvailable,
        supportsVision: model.supportsVision,
      }));
      this.status.value = this.models.value.length ? "ready" : "empty";
      // Preserve a stale saved choice visibly; selecting another configured ID
      // is explicit recovery, not an unreported switch to a different model.
    } catch {
      if (request !== this.request) return;
      this.status.value = "error";
    }
  };

  private readonly getModelsByPrompt = async (promptName: string) => {
    return this.gqlService
      .gql({
        query: getPromptModelsQuery,
        variables: { promptName },
      })
      .then((res) => res.currentUser?.copilot?.models);
  };
}
