# uru-frameworks-honda-store-api

**Note:** This repository is archived and read-only.

Honda Parts e-commerce API from the Frameworks college course (URU): a Firebase project whose backend is a set of HTTPS Cloud Functions (v2, TypeScript, Node 22) over Firestore, covering users, products and shopping carts.

## Project structure

- **`functions/src/index.ts`** — all HTTP functions, wrapped in a CORS helper
- **`firestore.rules`**, **`storage.rules`** — security rules (Firestore collections `products`, `carts`, `users`)
- **`firebase.json`** — functions config and emulator ports (auth 9099, functions 5001, firestore 8080, database 9000, storage 9199)

## Exported functions

- **Users** — `create_user`, `get_user_by_id`
- **Carts** — `add_product_to_cart`, `remove_product_from_cart`, `update_product_quantity_in_cart`, `get_cart`, `clear_cart`, `checkout_cart`
- **Products** — `create_product`, `get_product_by_id`, `update_product`, `remove_product`, `get_my_products`, `search_products`, `search_my_products`, `get_latest_products`

## Development

Run from `functions/`; requires the Firebase CLI and a configured Firebase project.

```bash
npm install
npm run build    # tsc
npm run serve    # build + emulators
npm run deploy   # firebase deploy --only functions
```

## License

GNU General Public License v3.0 (see `LICENSE`).
