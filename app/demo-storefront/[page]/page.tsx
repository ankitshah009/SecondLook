import Link from "next/link";
import { notFound } from "next/navigation";
import { plans } from "@/lib/second-look";

export const dynamic = "force-dynamic";
const pages = { offer: "A little more entertainment.", pricing: "Choose your rhythm.", billing: "Your bill, explained.", cancellation: "Your choice to leave.", "quote-summary": "A final look at your plan." } as const;

export default async function StorefrontPage({ params, searchParams }: {
  params: Promise<{ page: string }>; searchParams: Promise<{ plan?: string; scenario?: string; revision?: string }>;
}) {
  const { page } = await params;
  if (!(page in pages)) notFound();
  const key = page as keyof typeof pages;
  const { plan: planId = "monthly", scenario = "standard", revision } = await searchParams;
  const selected = plans.find(plan => plan.id === planId) ?? plans[1];
  const changed = scenario === "changed" && revision === "final";
  const total = changed && selected.id === "monthly" ? 45 : selected.payableToday;
  const href = (path: string, plan?: string) => "/demo-storefront/" + path + "?" + new URLSearchParams({ scenario, ...(plan ? { plan } : {}) }).toString();

  return <main className="storefront-shell">
    <div className="storefront-banner">Synthetic storefront <span>No payment. No subscription.</span></div>
    <header className="storefront-nav"><Link href={href("offer")} className="storefront-brand"><span>◐</span> streamly</Link><nav aria-label="Storefront pages">{["pricing", "billing", "cancellation"].map(name => <Link key={name} href={href(name)}>{name}</Link>)}</nav></header>
    <section className="storefront-content"><div className="storefront-heading"><span>Entertainment on your terms</span><h1>{pages[key]}</h1><p>Independent films. Stories worth your time. One simple membership.</p></div>
      {(key === "offer" || key === "pricing") && <div className="storefront-plans">{plans.map(plan => <article className={"store-plan " + (plan.id === "annual" ? "annual-plan" : "")} key={plan.id}>
        <div className="store-plan-head"><span>{plan.name}</span>{plan.id === "annual" && <b>Lower monthly equivalent</b>}</div>
        <strong>{"$" + plan.monthlyEquivalent}<small>/month{plan.id === "annual" ? " equivalent" : ""}</small></strong>
        <p data-evidence={plan.id + "-total"}>{plan.name} plan: {"$" + plan.monthlyEquivalent} monthly equivalent, {"$" + plan.payableToday} payable today.</p>
        <p data-evidence={plan.id + "-term"}>{plan.cadence === "annual" ? "Annual billing. One-year commitment. Full year paid upfront." : "Monthly billing. No annual commitment. Renewed each month."}</p>
        <Link data-select-plan={plan.id} href={href("quote-summary", plan.id)}>Select {plan.name.toLowerCase()} plan <span>↗</span></Link>
      </article>)}</div>}
      {key === "billing" && <div className="storefront-details">{plans.map(plan => <article key={plan.id}><h2>{plan.name} billing</h2><p data-evidence={plan.id + "-billing"}>{plan.id === "annual" ? "Annual plan: $348 billed upfront for 12 months. $29 is the monthly equivalent, not a monthly charge." : "Monthly plan: $35 payable today and each month. No annual prepayment or annual commitment."}</p><small>Displayed totals include all charges in this synthetic fixture.</small></article>)}</div>}
      {key === "cancellation" && <article className="storefront-policy"><h2>{scenario === "missing" ? "Terms are being updated." : "Cancel before your next bill."}</h2><p data-evidence="cancellation">{scenario === "missing" ? "Cancellation timing has not been published for this synthetic offer." : "Monthly plan: cancel any time before the next billing date. Access continues through the current paid month. Annual plans remain active through the prepaid year."}</p><small>Illustrative policy for this demo only.</small></article>}
      {key === "quote-summary" && <article className="storefront-quote">
        <span data-quote-plan>{selected.name} plan</span><strong data-quote-total>{"$" + total}<small> due today</small></strong>
        <p data-quote-cadence>{selected.cadence === "monthly" ? "Monthly billing" : "Annual billing"}</p>
        <p data-quote-commitment>{selected.commitment ? "One-year commitment" : "No annual commitment"}</p>
        <p data-evidence="quote-summary">Quote summary: {selected.name} plan, {"$" + total} payable today, {selected.cadence} billing, {selected.commitment ? "annual commitment" : "no annual commitment"}.</p>
        <small>No purchase was made. All displayed amounts are final fixture totals.</small>
      </article>}
      {scenario === "changed" && <div className="fixture-scenario">Synthetic change scenario: the monthly quote is $35 on the initial visit and $45 on the approval recheck.</div>}
      {scenario === "missing" && <div className="fixture-scenario">Synthetic incomplete-terms scenario: cancellation timing is unavailable.</div>}
      <footer className="storefront-footer">A Second Look demo fixture <Link href="/">Return to Second Look</Link></footer>
    </section>
  </main>;
}
