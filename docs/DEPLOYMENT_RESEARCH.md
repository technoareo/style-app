# Deployment decision research — 12 October 2026

Perplexity was consulted in its Windows app with the current private-account / persistent SQLite / single local Ollama worker architecture and the user's no-existing-account constraint. Its visible recommendation was a fixed-price VPS for initial production rather than relying on Oracle Always Free capacity. It was asked for a broader garment evaluation plan as well; that part remains to be captured and assessed.

The initial target remains one persistent Linux Docker server, around four CPU cores, 16 GB RAM and enough local disk for the model, private data and backups. This is a sizing starting point, not measured production capacity. A Singapore Hetzner instance is a candidate for the user's region; the final plan, tax, IPv4, traffic and backup costs must be checked at purchase and approved before any paid resource is provisioned.

Primary-source verification supports the concern about free capacity: Oracle currently documents 2 OCPU / 12 GB for an Always Free ARM tenancy and warns that idle compute instances may be reclaimed. This differs from older 4 OCPU / 24 GB advice. Always Free should not be assumed to meet the starting specification or to provide guaranteed available launch capacity.

Sources checked directly:
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- https://www.oracle.com/cloud/free/faq/
- https://www.hetzner.com/cloud-singapore/
- https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/

No account was created, payment information entered or server purchased. A live domain, owner-controlled server and verified email sender are still external setup requirements. Free local model inference removes an AI API fee; it does not remove infrastructure and operation costs.
