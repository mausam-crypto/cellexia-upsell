import { json, redirect, type LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return json({});
};

export default function Index() {
  return (
    <main style={{ fontFamily: "Inter, sans-serif", padding: "4rem", maxWidth: 640 }}>
      <h1>Cellexia Post-Purchase Upsell</h1>
      <p>
        This is the backend of an embedded Shopify app. Open it from your
        Shopify admin (Apps &rarr; Cellexia Post-Purchase Upsell), or install it
        via the install link from the Partner Dashboard.
      </p>
    </main>
  );
}
