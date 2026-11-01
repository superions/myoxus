import { Service } from "@myoxus/infra";

import { ServerDocMeta } from "../entities/server-doc-meta";

export class ServerDocMetaService extends Service {
  serverDocMeta = this.framework.createEntity(ServerDocMeta);
}
