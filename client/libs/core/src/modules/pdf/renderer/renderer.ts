import { getWorkerUrl } from "@myoxus/env/worker";
import { OpClient } from "@myoxus/infra/op";

import type { ClientOps } from "./ops";

export class PDFRenderer extends OpClient<ClientOps> {
  private readonly worker: Worker;

  constructor() {
    const worker = new Worker(getWorkerUrl("pdf"));
    super(worker);

    this.worker = worker;
  }

  override destroy() {
    super.destroy();
    this.worker.terminate();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
