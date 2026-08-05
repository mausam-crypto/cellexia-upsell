import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { jparse } from "../lib/json";
import { getSettings } from "../services/settings.server";
import { translateUiStrings } from "../services/ai.server";
import {
  DEFAULT_UI_STRINGS_EN,
  LANGUAGE_LABELS,
  UI_STRING_KEYS,
} from "../types";

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await getSettings(shop);
  const languages = settings.languages.length > 0 ? settings.languages : ["en"];

  const url = new URL(request.url);
  const requested = url.searchParams.get("lang") ?? "";
  const language = languages.includes(requested)
    ? requested
    : languages.includes(settings.defaultLanguage)
      ? settings.defaultLanguage
      : languages[0];

  const [rows, enRows] = await Promise.all([
    prisma.uiString.findMany({ where: { shop, language } }),
    prisma.uiString.findMany({ where: { shop, language: "en" } }),
  ]);

  const values: Record<string, string> = {};
  for (const row of rows) {
    if (UI_STRING_KEYS.includes(row.key)) values[row.key] = row.value;
  }
  const enValues: Record<string, string> = {};
  for (const key of UI_STRING_KEYS) {
    enValues[key] =
      enRows.find((r) => r.key === key)?.value ?? DEFAULT_UI_STRINGS_EN[key];
  }

  return json({ language, languages, values, enValues });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");
  const language = String(fd.get("language") ?? "");

  const respond = (ok: boolean, message: string, status = 200) =>
    json({ ok, message, intent }, { status });

  if (!language) {
    return respond(false, "Missing language.", 400);
  }

  if (intent === "save") {
    const record = jparse<Record<string, string>>(
      String(fd.get("valuesJson") ?? "{}"),
      {},
    );
    let saved = 0;
    for (const key of UI_STRING_KEYS) {
      const raw = record[key];
      if (typeof raw !== "string") continue;
      const value = raw.trim();
      if (value) {
        await prisma.uiString.upsert({
          where: { shop_language_key: { shop, language, key } },
          update: { value },
          create: { shop, language, key, value },
        });
        saved += 1;
      } else {
        // Clearing a field removes the override so the EN fallback applies.
        await prisma.uiString.deleteMany({ where: { shop, language, key } });
      }
    }
    return respond(
      true,
      `Saved ${saved} string${saved === 1 ? "" : "s"} for ${languageLabel(language)}.`,
    );
  }

  if (intent === "translate-missing" || intent === "translate-all") {
    if (language === "en") {
      return respond(
        false,
        "English is the source language — edit the values directly.",
      );
    }
    try {
      const result = await translateUiStrings(shop, [language], {
        onlyMissing: intent === "translate-missing",
      });
      const errorCount = result.errors.length;
      const suffix =
        errorCount > 0
          ? ` (${errorCount} error${errorCount === 1 ? "" : "s"} — see server logs)`
          : "";
      return respond(
        errorCount === 0 || result.translated > 0,
        `Translated ${result.translated} string${
          result.translated === 1 ? "" : "s"
        } for ${languageLabel(language)}${suffix}.`,
      );
    } catch (error) {
      console.error("[translations] auto-translate failed", error);
      return respond(false, "Translation failed — check the server logs.");
    }
  }

  return respond(false, "Unknown action.", 400);
};

export default function TranslationsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [, setSearchParams] = useSearchParams();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...data.values,
  }));
  // Re-initialize the fields whenever the selected language or the stored
  // values change (language switch, save, auto-translate).
  const resetKey = `${data.language}:${JSON.stringify(data.values)}`;
  useEffect(() => {
    setValues({ ...data.values });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const busy = (intent: string) =>
    navigation.state === "submitting" &&
    String(navigation.formData?.get("intent") ?? "") === intent;
  const anyBusy = navigation.state === "submitting";

  const languageOptions = data.languages.map((code) => ({
    label: `${languageLabel(code)} (${code})`,
    value: code,
  }));

  const handleLanguageChange = (value: string) => {
    setSearchParams({ lang: value });
  };

  const handleSave = () => {
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("language", data.language);
    fd.set("valuesJson", JSON.stringify(values));
    submit(fd, { method: "post" });
  };

  const handleTranslate = (intent: "translate-missing" | "translate-all") => {
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("language", data.language);
    submit(fd, { method: "post" });
  };

  const isEnglish = data.language === "en";
  const missingCount = UI_STRING_KEYS.filter(
    (key) => !(values[key] ?? "").trim(),
  ).length;

  return (
    <Page
      title="Translations"
      subtitle="Buyer-facing labels for the post-purchase and thank-you offers."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info" title="These are the static labels only">
              <p>
                The offer copy itself (headline, body, bullets) is generated
                per-language by AI at offer time. The strings below are the
                static buttons and labels shown around it — "Add to my order",
                "No thanks", price labels, and so on. Empty fields fall back to
                the English value.
              </p>
            </Banner>

            <Card>
              <BlockStack gap="400">
                <InlineStack gap="400" wrap blockAlign="end">
                  <Box minWidth="260px">
                    <Select
                      label="Language"
                      options={languageOptions}
                      value={data.language}
                      onChange={handleLanguageChange}
                      disabled={anyBusy}
                      helpText="Save your edits before switching languages."
                    />
                  </Box>
                  <Button
                    onClick={() => handleTranslate("translate-missing")}
                    loading={busy("translate-missing")}
                    disabled={isEnglish || anyBusy}
                  >
                    Auto-translate missing
                  </Button>
                  <Button
                    onClick={() => handleTranslate("translate-all")}
                    loading={busy("translate-all")}
                    disabled={isEnglish || anyBusy}
                  >
                    Re-translate all
                  </Button>
                </InlineStack>
                {!isEnglish && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {missingCount > 0
                      ? `${missingCount} of ${UI_STRING_KEYS.length} strings are missing for ${languageLabel(
                          data.language,
                        )}. "Re-translate all" overwrites every string, including manual edits.`
                      : `All ${UI_STRING_KEYS.length} strings are set for ${languageLabel(
                          data.language,
                        )}. "Re-translate all" overwrites every string, including manual edits.`}
                  </Text>
                )}
                <Divider />
                <BlockStack gap="300">
                  {UI_STRING_KEYS.map((key) => (
                    <TextField
                      key={`${data.language}-${key}`}
                      label={key}
                      value={values[key] ?? ""}
                      onChange={(v) =>
                        setValues((prev) => ({ ...prev, [key]: v }))
                      }
                      placeholder={data.enValues[key]}
                      helpText={`English: ${data.enValues[key]}`}
                      autoComplete="off"
                    />
                  ))}
                </BlockStack>
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleSave}
                    loading={busy("save")}
                  >
                    Save all
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
