import {initializeApp, cert, ServiceAccount} from 'firebase-admin/app'
import {getFirestore} from 'firebase-admin/firestore'
import {onCall, HttpsError} from 'firebase-functions/v2/https'
import {DocumentReference} from 'firebase-admin/firestore'
import serviceAccount from '../../uru-frameworks-honda-store-firebase-adminsdk.json'

// Auth data
interface AuthData {
  uid: string;
  token: {
    email?: string;
    name?: string;
    [key: string]: any;
  };
}

// User data
type UserData = {
  first_name: string,
  last_name: string,
  uid: string,
}

// Product data
type ProductData = {
  title: string,
  description: string,
  price: number,
  stock: number,
  active: boolean,
  brand: string,
  tags: string[],
  owner: string,
  image_url: string,
}

// Cart data
type CartData = {
  owner: string,
  status: string,
  products: {
    [key: string]: {
      id: string,
      price: number,
      quantity: number,
    }
  }
}

// Initialize the Firebase Admin SDK
const app = initializeApp({
  credential: cert(serviceAccount as ServiceAccount)
});

// Firebase Firestore instance
const firestore = getFirestore(app);

// Check if the user is authenticated
function checkAuth(auth?:AuthData) {
  if (!auth || !auth?.uid) {
    throw new HttpsError('unauthenticated',
      'User must be authenticated.'
    );
  }

  return auth.uid;
}

// Get the current pending cart reference for the user
async function getCurrentPendingCartRef(userId:string) {
  const cartRef = firestore.collection('carts').where('owner',
    '==',
    userId
  ).where('status', '==', 'pending');
  return await cartRef.get();
}

// Get a product data by ID
async function getProductDataById(productId:string):Promise<[DocumentReference, ProductData]> {
  const productRef = firestore.collection('products').doc(productId);
  const productSnapshot = await productRef.get();

  // Check if the product exists
  if (!productSnapshot.exists) {
    throw new HttpsError('not-found', 'Product not found.');
  }

  return [productRef, productSnapshot.data() as ProductData];
}

// Check if the product is active
async function checkProductActive(productData:ProductData) {
  if (!productData?.active) {
    throw new HttpsError('unavailable',
      'This product is currently unavailable.'
    );
  }
}

// Check if the product has stock
async function checkProductStock(productData: ProductData, quantity:number) {
  if (productData?.stock <= 0) {
    throw new HttpsError('unavailable',
      'This product is out of stock.'
    );
  }
  if (quantity && productData?.stock < quantity) {
    throw new HttpsError('unavailable',
      'Not enough stock available.'
    );
  }
}

// Validate if the field is a non-empty string
function validateEmptyStringField(fieldValue:string, fieldName:string) {
  if (!fieldValue || fieldValue?.trim() === '') {
    throw new HttpsError('invalid-argument',
      `${fieldName} must be a non-empty string.`
    );
  }
}

// Validate if the field is a positive number
function validatePositiveNumberField(fieldValue:number, fieldName:string) {
  if (!fieldValue || fieldValue <= 0) {
    throw new HttpsError('invalid-argument',
      `${fieldName} must be a positive number.`
    );
  }
}

// Create user data
type CreateUserData = {
  first_name: string,
  last_name: string,
}

// Function to create a user
export const create_user = onCall(async ({data, auth}:{data:CreateUserData, auth?:AuthData}) => {
  // Check if the user is authenticated
    const userId = checkAuth(auth);

  // Validate input data
  const {first_name, last_name} = data;
  const mappedFields: Record<string, any> = {
    'First name': first_name,
    'Last name': last_name,
  }
  for (const mappedFieldKey in mappedFields) {
    validateEmptyStringField(mappedFields[mappedFieldKey], mappedFieldKey);
  }

  // Create a new user object
  const newUser = {
    first_name: first_name,
    last_name: last_name,
  };

  // Save the user to Firestore
  await firestore.collection('users').doc(userId).set(newUser);

  return {message: 'User created successfully.'};
});

// Function to get a user by ID
export const get_user_by_id = onCall(async ({auth}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Retrieve the user document
  const userDoc = await firestore.collection('users').doc(userId).get();

  // Return the user data
  const userData = userDoc.data() as UserData;
  return {user: userData};
});

// Add product to cart data
type AddProductToCartData = {
  productId: string,
  quantity: number,
}

// Function to add a product to the cart
export const add_product_to_cart = onCall(async ({data, auth}:{data:AddProductToCartData, auth?:AuthData}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Validate input data
  const {productId, quantity} = data;
  validateEmptyStringField(productId, 'Product ID');
  validatePositiveNumberField(quantity, 'Quantity');

  // Get the current pending cart
  const cartSnapshot = await getCurrentPendingCartRef(userId);

  // Get the product data
  const [,productData] = await getProductDataById(productId);

  // Check if the product is active
  await checkProductActive(productData);

  // Check if the product has stock
  await checkProductStock(productData, quantity);

  if (cartSnapshot.empty) {
    // Create a new cart
    const newCart = {
      owner: userId,
      status: 'pending',
      products: {
        [productId]: {
          id: productId,
          price: productData.price,
          quantity: quantity,
        },
      },
    };
    await firestore.collection('carts').add(newCart);
  } else {
    const cartDocument = cartSnapshot.docs[0];
    const cartData = cartDocument.data();
    const existingProduct = cartData.products && cartData.products[productId];

    const updatedProducts = {...cartData.products};

    // Check if the product already exists in the cart
    if (existingProduct) {
      // Update the quantity of the existing product
      updatedProducts[productId].quantity += quantity;
    } else {
      updatedProducts[productId] = {
        id: productId,
        price: productData.price,
        quantity: quantity,
      };
    }

    await cartDocument.ref.update({products: updatedProducts});
  }

  return {message: 'Product added to cart successfully.'};
});

// Remove product from cart data
type RemoveProductFromCartData = {
  productId: string,
}

// Function to remove a product from the cart
export const remove_product_from_cart = onCall(async ({data, auth}:{data:RemoveProductFromCartData, auth?:AuthData}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Validate input data
  const {productId} = data;
  validateEmptyStringField(productId, 'Product ID');

  // Get the current pending cart
  const cartSnapshot = await getCurrentPendingCartRef(userId);
  if (cartSnapshot.empty) {
    throw new HttpsError('not-found',
      'No pending cart found for this user.'
    );
  }

  // Get the cart document
  const cartDocument = cartSnapshot.docs[0];
  const cartData = cartDocument.data();
  if (!cartData?.products[productId]) {
    throw new HttpsError('not-found',
      'Product not found in the cart.'
    );
  }

  // Remove the product from the cart
  const updatedProducts = {...cartData.products};
  delete updatedProducts[productId];

  await cartDocument.ref.update({products: updatedProducts});

  return {message: 'Product removed from cart successfully.'};
});

// Update product quantity in cart data
type UpdateProductQuantityInCartData = {
  productId: string,
  quantity: number,
}

// Function to update the quantity of a product in the cart
export const update_product_quantity_in_cart = onCall(async ({data, auth}:{data:UpdateProductQuantityInCartData, auth?:AuthData}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Validate input data
  const {productId, quantity} = data;

  // Get the current pending cart
  const cartSnapshot = await getCurrentPendingCartRef(userId);
  if (cartSnapshot.empty) {
    throw new HttpsError('not-found',
      'No pending cart found for this user.'
    );
  }

  // Get the cart document
  const cartDocument = cartSnapshot.docs[0];
  const cartData = cartDocument.data();
  if (!cartData?.products[productId]) {
    throw new HttpsError('not-found',
      'Product not found in the cart.'
    );
  }

  // Get the product data
  const [, productData] = await getProductDataById(productId);

  // Check if the product is active
  await checkProductActive(productData);

  // Check if the product has stock
  await checkProductStock(productData, quantity);

  const updatedProducts = {...cartData.products};
  updatedProducts[productId].quantity = quantity;

  await cartDocument.ref.update({products: updatedProducts});

  return {message: 'Product quantity updated successfully.'};
});

// Function to get the cart
export const get_cart = onCall(async ({auth}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Get the current pending cart
  const cartSnapshot = await getCurrentPendingCartRef(userId);
  if (cartSnapshot.empty) {
    throw new HttpsError('not-found',
      'No pending cart found for this user.'
    );
  }

  // Get the cart document
  const cartDocument = cartSnapshot.docs[0];
  const cartData = cartDocument.data() as CartData;

  return {cart: cartData};
});

// Function to clear the cart
export const clear_cart = onCall(async ({auth}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Get the current pending cart
  const cartSnapshot = await getCurrentPendingCartRef(userId);
  if (cartSnapshot.empty) {
    throw new HttpsError('not-found',
      'No pending cart found for this user.'
    );
  }

  // Get the cart document
  const cartDocument = cartSnapshot.docs[0];

  await cartDocument.ref.update({products: {}});

  return {message: 'Cart cleared successfully.'};
});

// Function to check out the cart
export const checkout_cart = onCall(async ({auth}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Get the current pending cart
  const cartSnapshot = await getCurrentPendingCartRef(userId);
  if (cartSnapshot.empty) {
    throw new HttpsError('not-found',
      'No pending cart found for this user.'
    );
  }

  // Get the cart document
  const cartDocument = cartSnapshot.docs[0];

  // Perform checkout logic here (e.g., payment processing, order creation)

  // Update the cart status to 'completed'
  await cartDocument.ref.update({status: 'completed'});

  return {message: 'Checkout completed successfully.'};
});

// Create product data
type CreateProductData = {
  title: string,
  description: string,
  price: number,
  stock: number,
  active: boolean,
  brand: string,
  tags: string[],
  image_url: string,
}

// Function to create a new product
export const create_product = onCall(async ({data, auth}:{data:CreateProductData, auth?:AuthData}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Validate input data
  const {title, description, price, stock, active, brand, tags, image_url} = data;
  const mappedStringFields: Record<string, any> = {
    'Title': title,
    'Description': description,
    'Brand': brand,
    'Image URL': image_url,
  }
  const mappedPositiveNumberFields: Record<string, any> = {
    'Price': price,
    'Stock': stock,
  }
  for (const mappedFieldKey in mappedStringFields) {
    validateEmptyStringField(mappedStringFields[mappedFieldKey], mappedFieldKey);
  }
  for (const mappedFieldKey in mappedPositiveNumberFields) {
    validatePositiveNumberField(mappedPositiveNumberFields[mappedFieldKey], mappedFieldKey);
  }

  // Create a new product object
  const newProduct = {
    title: title,
    description: description,
    price: price,
    stock: stock,
    active: active,
    brand: brand,
    tags: Array.isArray(tags) ? tags : [],
    owner: userId,
    image_url: image_url,
  };
  const productRef = await firestore.collection('products').add(newProduct);

  return {message: 'Product created successfully.', productId: productRef.id};
});

// Get products data
type GetProductsData = {
  limit: number,
  offset: number,
}

// Function to get products
export const get_products = onCall(async ({data}:{data:GetProductsData}) => {
  // Validate input data
  const {limit = 10, offset = 0} = data;
  const mappedFields: Record<string, any> = {
    'Limit': limit,
    'Offset': offset,
  }
  for (const mappedFieldKey in mappedFields) {
    validatePositiveNumberField(mappedFields[mappedFieldKey], mappedFieldKey);
  }

  // Get the products
  const productsRef = firestore.collection('products')
    .where('active', '==', true)
    .limit(limit)
    .offset(offset);
  const productSnapshot = await productsRef.get();
  const products: Record<string,  ProductData> = {};
  productSnapshot.forEach(doc => {
    products[doc.id] = doc.data() as ProductData;
  });

  // Get the total count of active products
  const totalCountSnapshot = await firestore.collection('products').where(
    'active',
    '==',
    true
  ).count().get();
  const totalCount = totalCountSnapshot.data().count;

  return {products, totalCount};
});

// Get product by ID data
type GetProductByIdData = {
  productId: string,
}

// Function to get a product by ID
export const get_product_by_id = onCall(async ({data, auth}:{data:GetProductByIdData, auth?:AuthData}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Validate input data
  const {productId} = data;
  validateEmptyStringField(productId, 'Product ID');

  // Get the product data
  const [productRef, productData] = await getProductDataById(productId);

  // Check if the product is active if the user is not the owner
  if (productData.owner !== userId) {
    await checkProductActive(productData);
  }

  return {product: {id: productRef.id, ...productData}};
});

// Update product data
type UpdateProductData = {
  productId: string,
  title?: string,
  description?: string,
  price?: number,
  stock?: number,
  active?: boolean,
  brand?: string,
  tags?: string[],
  image_url?: string,
}

// Function to update a product
export const update_product = onCall(async ({data, auth}:{data:UpdateProductData, auth?:AuthData}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Validate input data
  const {productId, title, description, price, stock, active, brand, tags, image_url} = data;
  validateEmptyStringField(productId, 'Product ID');

  // Build the updates object
  const updates: Record<string, any> = {};
  const mappedFields: Record<string, any> = {
    title,
    description,
    price,
    stock,
    active,
    brand,
    tags,
    image_url,
  }
  for (const fieldKey in mappedFields) {
    if (mappedFields?.[fieldKey] !== undefined) {
      updates[fieldKey] = mappedFields[fieldKey];
    }
  }

  // Get the product data
  const [productRef, productData] = await getProductDataById(productId);
  if (productData.owner !== userId) {
    throw new HttpsError('permission-denied',
      'You are not the owner of this product.'
    );
  }

  await productRef.update({...updates});

  return {message: 'Product updated successfully.'};
});

// Remove product data
type RemoveProductData = {
  productId: string,
}

// Function to remove a product
export const remove_product = onCall(async ({data, auth}:{data:RemoveProductData, auth?: AuthData}) => {
  // Check if the user is authenticated
  const userId = checkAuth(auth);

  // Validate input data
  const {productId} = data;
  validateEmptyStringField(productId, 'Product ID');

  // Get the product data
  const [productRef, productData] = await getProductDataById(productId);
  if (productData.owner !== userId) {
    throw new HttpsError('permission-denied',
      'You are not the owner of this product.'
    );
  }
  await productRef.delete();

  return {message: 'Product removed successfully.'};
});

