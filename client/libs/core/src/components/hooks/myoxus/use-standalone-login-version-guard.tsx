import type { Server } from "@myoxus/core/modules/server";
import { useLiveData } from "@myoxus/infra";
import { AuthStatusText } from "@myoxus/ui-facade";
import semver from "semver";

const rules = [
  {
    min: "0.23.0",
    tip: (receivedVersion: string, requiredVersion: string) => (
      <>
        <AuthStatusText state="error">
          Your server version <strong>{receivedVersion}</strong> is not
          compatible with current client. Please upgrade your server to{" "}
          <strong>{requiredVersion}</strong> or higher to use this client.
        </AuthStatusText>
        <AuthStatusText>
          <strong>Instructions:</strong>
          <br />
          <a
            href={BUILD_CONFIG.upgradeGuideUrl}
            target="_blank"
            rel="noreferrer"
          >
            {BUILD_CONFIG.upgradeGuideUrl}
          </a>
        </AuthStatusText>
      </>
    ),
  },
];

/**
 * Return the error tip if the server version is not meet the requirement
 */
export const useStandaloneLoginVersionGuard = (server: Server) => {
  const serverVersion =
    useLiveData(server.config$.selector((c) => c.version)) ?? "0.0.0";

  for (const rule of rules) {
    if (semver.lt(serverVersion, rule.min)) {
      return rule.tip(serverVersion, rule.min);
    }
  }

  return null;
};
