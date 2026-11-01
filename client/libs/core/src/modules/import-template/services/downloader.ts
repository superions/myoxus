import { Service } from "@myoxus/infra";

import { TemplateDownloader } from "../entities/downloader";

export class TemplateDownloaderService extends Service {
  downloader = this.framework.createEntity(TemplateDownloader);
}
