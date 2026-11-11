// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="build-config" />

import {
  Box,
  Button as MantineButton,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
} from "@mantine/core";
import { getArtworkUrl } from "@myoxus/theme/artwork";
import { Trans, useI18n } from "@myoxus/i18n";
import { useCallback } from "react";

import { ThemedImg } from "./themed-img";

export function EditorLoading({
  longerLoading = false,
}: {
  longerLoading?: boolean;
}) {
  const t = useI18n();
  const reloadPage = useCallback(() => {
    document.location.reload();
  }, []);

  return (
    <Container size="xs" h="100%" w="100%" px="md">
      <Stack
        align="center"
        gap="md"
        h="100%"
        justify="center"
        w="100%"
        data-myoxus-ui-role="page-detail-loading-editor"
      >
        <Box w="100%" data-myoxus-ui-role="page-detail-loading-artwork">
          <ThemedImg
            draggable={false}
            fluid
            lightSrc={getArtworkUrl("loading")}
          />
        </Box>
        {longerLoading ? (
          <Stack
            align="center"
            gap="md"
            w="100%"
            data-longer-loading
            data-myoxus-ui-role="page-detail-loading-content"
          >
            <Stack gap="xs" w="100%">
              <Text
                c="myoxus-text-secondary"
                component="p"
                size="body"
                ta="start"
                data-longer-loading
                data-myoxus-ui-role="page-detail-loading-text"
              >
                {t["com.myoxus.error.loading-timeout-error"]()}
              </Text>
              <Text
                c="myoxus-text-secondary"
                component="p"
                size="body"
                ta="start"
                data-longer-loading
                data-myoxus-ui-role="page-detail-loading-text"
              >
                <Trans
                  i18nKey="com.myoxus.error.contact-us"
                  components={{
                    1: (
                      <Text
                        c="myoxus-text-link"
                        component="a"
                        href={BUILD_CONFIG.communityUrl}
                        rel="noreferrer"
                        size="link"
                        target="__blank"
                      />
                    ),
                  }}
                />
              </Text>
            </Stack>
            <MantineButton size="lg" onClick={reloadPage} variant="filled">
              {t["com.myoxus.error.reload"]()}
            </MantineButton>
          </Stack>
        ) : (
          <Stack
            align="center"
            gap="xs"
            w="100%"
            data-myoxus-ui-role="page-detail-loading-content"
          >
            <Group align="center" gap="xs" justify="center" wrap="nowrap">
              <Loader data-myoxus-ui-role="settings-loader" />
              <Text
                c="myoxus-text-primary"
                component="span"
                size="body"
                data-myoxus-ui-role="page-detail-loading-title"
              >
                {t["com.myoxus.loading"]()}
              </Text>
            </Group>
            <Text
              c="myoxus-text-secondary"
              component="p"
              size="body-small"
              ta="center"
              data-myoxus-ui-role="page-detail-loading-text"
            >
              {t["com.myoxus.loading.description"]()}
            </Text>
          </Stack>
        )}
      </Stack>
    </Container>
  );
}

export function PageDetailLoading() {
  return (
    <Center h="100%" px="md" w="100%" data-myoxus-ui-role="page-detail-loading">
      <EditorLoading />
    </Center>
  );
}
