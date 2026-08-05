// ─────────────────────────────────────────────────────────────────────────────
// Login — shop-domain entry point into the OAuth flow. Remix prefers this
// specific route over the auth.$ splat for /auth/login, whose
// authenticate.admin call the library rejects on this path with a 500.
// Deliberately Polaris-free: it renders outside the embedded admin, before
// any session exists.
// ─────────────────────────────────────────────────────────────────────────────

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { LoginErrorType } from "@shopify/shopify-app-remix/server";
import type { LoginError } from "@shopify/shopify-app-remix/server";
import { login } from "../shopify.server";

function loginErrorMessage(errors: LoginError): { shop: string | null } {
  if (errors.shop === LoginErrorType.MissingShop) {
    return { shop: "Please enter your shop domain to log in." };
  }
  if (errors.shop === LoginErrorType.InvalidShop) {
    return { shop: "Please enter a valid shop domain to log in." };
  }
  return { shop: null };
}

// login() throws a redirect into the OAuth flow when a valid shop is present;
// otherwise it returns field errors for the form below.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return json({ errors });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return json({ errors });
};

export default function AuthLogin() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopError = actionData?.errors.shop ?? loaderData.errors.shop;

  return (
    <main
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "4rem 1rem",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <Form
        method="post"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          width: "100%",
          maxWidth: "24rem",
        }}
      >
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Log in</h1>
        <label htmlFor="shop" style={{ fontSize: "0.875rem" }}>
          Shop domain
        </label>
        <input
          id="shop"
          type="text"
          name="shop"
          placeholder="my-shop-domain.myshopify.com"
          autoComplete="on"
          style={{
            padding: "0.5rem",
            fontSize: "1rem",
            border: "1px solid #8c9196",
            borderRadius: "0.5rem",
          }}
        />
        {shopError ? (
          <p style={{ color: "#8e1f0b", margin: 0, fontSize: "0.875rem" }}>
            {shopError}
          </p>
        ) : null}
        <button
          type="submit"
          style={{
            padding: "0.5rem 1rem",
            fontSize: "1rem",
            borderRadius: "0.5rem",
            border: "none",
            background: "#1a1a1a",
            color: "#ffffff",
            cursor: "pointer",
          }}
        >
          Log in
        </button>
      </Form>
    </main>
  );
}
