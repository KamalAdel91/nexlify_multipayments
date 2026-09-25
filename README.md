### Multi Payment

Adds a **Multi Expense / Revenue** checkbox to Payment Entry.
When ticked, Party is hidden and a table of accounts is posted directly:

- **Pay** → each line is Debited, bank is Credited with the total.
- **Receive** → each line is Credited, bank is Debited with the total.

Normal Payment Entries (checkbox off) behave exactly like standard ERPNext.

```bash
bench get-app <repo-url>
bench --site <site> install-app multi_payment
bench --site <site> migrate && bench build --app multi_payment && bench restart
```
