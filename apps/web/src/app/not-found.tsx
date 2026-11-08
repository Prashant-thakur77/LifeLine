import { ButtonLink } from "../components/ui";

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <p className="num text-[13px] text-rescue-ink">404</p>
      <h1 className="font-display text-[34px] text-ink">Nothing here</h1>
      <p className="max-w-md text-[15px] text-body">This page doesn&apos;t exist. The live demo and the public ledger are a click away.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <ButtonLink href="/position?user=demo.near" variant="primary">
          Watch the live demo
        </ButtonLink>
        <ButtonLink href="/">Home</ButtonLink>
      </div>
    </div>
  );
}
