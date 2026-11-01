// ORDER MATTERS
import "./env";
import "./public-path";
import "./telemetry";

import { configureMyoxusGraphQLClientContext } from "../modules/server/services/graphql";

configureMyoxusGraphQLClientContext({ client: "myoxus-electron" });
