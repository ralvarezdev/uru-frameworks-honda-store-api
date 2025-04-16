import {cert, initializeApp, ServiceAccount} from 'firebase-admin/app';
import {DocumentReference, getFirestore} from 'firebase-admin/firestore';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import serviceAccount from '../../uru-frameworks-honda-store-firebase-adminsdk.json';
import {Logging} from '@google-cloud/logging';

// Set to true to enable logging
const DEBUG = true;

// Initialize Google Cloud Logging
const logging = new Logging();
const log = logging.log('cloud-functions-log');

// Helper function to log messages
function logMessage(message: string, severity: 'INFO' | 'ERROR' | 'WARNING' = 'INFO') {
    if (DEBUG) {
        const entry = log.entry({severity}, {message});
        log.write(entry).catch(console.error);
    }
}

// Helper function to log information
function logInfo(message: string) {
    logMessage(message, 'INFO');
}

// Helper function to log warning
function logWarning(message: string) {
    logMessage(message, 'WARNING');
}

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
function checkAuth(auth?: AuthData) {
    if (!auth || !auth?.uid) {
        logWarning(`User not authenticated`);
        throw new HttpsError('unauthenticated',
            'User must be authenticated'
        );
    }

    logInfo(`User authenticated with ID: ${auth.uid}`);
    return auth.uid;
}

// Get the current pending cart reference for the user
async function getCurrentPendingCartRef(userId: string) {
    // Log the action
    logInfo(`Getting pending cart for user: ${userId}`);

    // Query the Firestore collection for the user's cart
    const cartRef = firestore.collection('carts').where('owner',
        '==',
        userId
    ).where('status', '==', 'pending');
    return await cartRef.get();
}

// Get a product data by ID
async function getProductDataById(productId: string): Promise<[DocumentReference, ProductData]> {
    // Log the action
    logInfo(`Getting product data for ID: ${productId}`);

    // Query the Firestore collection for the product
    const productRef = firestore.collection('products').doc(productId);
    const productSnapshot = await productRef.get();

    // Check if the product exists
    if (!productSnapshot.exists) {
        logWarning(`Product not found with ID: ${productId}`);
        throw new HttpsError('not-found', 'Product not found');
    }

    return [productRef, productSnapshot.data() as ProductData];
}

// Check if the product is active
async function checkProductActive(productData: ProductData) {
    if (!productData?.active) {
        logWarning(`Product is inactive: ${productData.title}`);
        throw new HttpsError('unavailable',
            'This product is currently unavailable'
        );
    }
}

// Check if the product has stock
async function checkProductStock(productData: ProductData, quantity: number) {
    if (productData?.stock <= 0) {
        logWarning(`Product "${productData.title}" is out of stock.`);
        throw new HttpsError('unavailable',
            'This product is out of stock'
        );
    }
    if (quantity && productData?.stock < quantity) {
        logWarning(`Not enough stock for product "${productData.title}". Requested: ${quantity}, Available: ${productData.stock}`);
        throw new HttpsError('unavailable',
            'Not enough stock available'
        );
    }
}

// Validate if the field is a non-empty string
function validateEmptyStringField(fieldValue: string, fieldName: string) {
    if (!fieldValue || fieldValue?.trim() === '') {
        logWarning(`Invalid argument: ${fieldName} must be a non-empty string`);
        throw new HttpsError('invalid-argument',
            `${fieldName} must be a non-empty string`
        );
    }
}

// Validate if the field is a positive number
function validatePositiveNumberField(fieldValue: number, fieldName: string) {
    if (!fieldValue || fieldValue <= 0) {
        logWarning(`Invalid argument: ${fieldName} must be a positive number`);
        throw new HttpsError('invalid-argument',
            `${fieldName} must be a positive number`
        );
    }
}

// Create user data
type CreateUserData = {
    first_name: string,
    last_name: string,
}

// Function to create a user
export const create_user = onCall(async ({data, auth}: { data: CreateUserData, auth?: AuthData }) => {
    logInfo('Function create_user called');

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
    logInfo(`User created successfully with ID: ${userId}`);

    return {message: 'User created successfully'};
});

// Function to get a user by ID
export const get_user_by_id = onCall(async ({auth}) => {
    logInfo('Function get_user_by_id called');

    // Check if the user is authenticated
    const userId = checkAuth(auth);

    // Retrieve the user document
    const userDoc = await firestore.collection('users').doc(userId).get();
    if (!userDoc.exists) {
        logWarning(`User not found with ID: ${userId}`);
        throw new HttpsError('not-found', 'User not found');
    }

    // Return the user data
    const userData = userDoc.data() as UserData;
    logInfo(`Retrieved user data: ${JSON.stringify(userData)}`);

    return {user: userData};
});

// Add product to cart data
type AddProductToCartData = {
    productId: string,
    quantity: number,
}

// Function to add a product to the cart
export const add_product_to_cart = onCall(async ({data, auth}: { data: AddProductToCartData, auth?: AuthData }) => {
    logInfo(`Function add_product_to_cart called`);

    // Check if the user is authenticated
    const userId = checkAuth(auth);

    // Validate input data
    const {productId, quantity} = data;
    validateEmptyStringField(productId, 'Product ID');
    validatePositiveNumberField(quantity, 'Quantity');
    logInfo(`Adding product ${productId} with quantity ${quantity} to cart for user ${userId}`);

    // Get the current pending cart
    const cartSnapshot = await getCurrentPendingCartRef(userId);

    // Get the product data
    const [, productData] = await getProductDataById(productId);

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
        logInfo(`New cart created and product "${productData.title}" added`);
    } else {
        const cartDocument = cartSnapshot.docs[0];
        const cartData = cartDocument.data() as CartData;
        const existingProduct = cartData.products && cartData.products[productId];

        const updatedProducts = {...cartData.products};

        // Check if the product already exists in the cart
        if (existingProduct) {
            // Update the quantity of the existing product
            updatedProducts[productId].quantity += quantity;
            logInfo(`Incrementing quantity of product "${productData.title}" in cart to ${updatedProducts[productId].quantity}`);
        } else {
            updatedProducts[productId] = {
                id: productId,
                price: productData.price,
                quantity: quantity,
            };
            logInfo(`Adding product "${productData.title}" to existing cart`);
        }

        await cartDocument.ref.update({products: updatedProducts});
        logInfo(`Product "${productData.title}" added to cart successfully`);
    }

    return {message: 'Product added to cart successfully'};
});

// Remove product from cart data
type RemoveProductFromCartData = {
    productId: string,
}

// Function to remove a product from the cart
export const remove_product_from_cart = onCall(async ({data, auth}: {
    data: RemoveProductFromCartData,
    auth?: AuthData
}) => {
    logInfo(`Function remove_product_from_cart called`);

    // Check if the user is authenticated
    const userId = checkAuth(auth);

    // Validate input data
    const {productId} = data;
    validateEmptyStringField(productId, 'Product ID');

    // Get the current pending cart
    const cartSnapshot = await getCurrentPendingCartRef(userId);
    if (cartSnapshot.empty) {
        logWarning(`No pending cart found for user: ${userId}`);
        throw new HttpsError('not-found', 'No pending cart found for this user');
    }

    // Get the cart document
    const cartDocument = cartSnapshot.docs[0];
    const cartData = cartDocument.data() as CartData;
    if (!cartData?.products[productId]) {
        logWarning(`Product ${productId} not found in the cart`);
        throw new HttpsError('not-found', 'Product not found in the cart');
    }

    // Remove the product from the cart
    const updatedProducts = {...cartData.products};
    delete updatedProducts[productId];

    await cartDocument.ref.update({products: updatedProducts});
    logInfo(`Product ${productId} removed from cart successfully`);

    return {message: 'Product removed from cart successfully'};
});

// Update product quantity in cart data
type UpdateProductQuantityInCartData = {
    productId: string,
    quantity: number,
}

// Function to update the quantity of a product in the cart
export const update_product_quantity_in_cart = onCall(async ({data, auth}: {
    data: UpdateProductQuantityInCartData,
    auth?: AuthData
}) => {
    logInfo(`Function update_product_quantity_in_cart called`);

    // Check if the user is authenticated
    const userId = checkAuth(auth);

    // Validate input data
    const {productId, quantity} = data;
    validateEmptyStringField(productId, 'Product ID');
    validatePositiveNumberField(quantity, 'Quantity');

    // Get the current pending cart
    const cartSnapshot = await getCurrentPendingCartRef(userId);
    if (cartSnapshot.empty) {
        logWarning(`No pending cart found for user: ${userId}`);
        throw new HttpsError('not-found', 'No pending cart found for this user');
    }

    // Get the cart document
    const cartDocument = cartSnapshot.docs[0];
    const cartData = cartDocument.data() as CartData;
    if (!cartData?.products[productId]) {
        logWarning(`Product ${productId} not found in the cart`)
        throw new HttpsError('not-found', 'Product not found in the cart')
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
    logInfo(`Product ${productId} quantity updated to ${quantity} in cart`)

    return {message: 'Product quantity updated successfully.'};
});

// Function to get the cart
export const get_cart = onCall(async ({auth}) => {
    logInfo(`Function get_cart called`)

    // Check if the user is authenticated
    const userId = checkAuth(auth);

    // Get the current pending cart
    const cartSnapshot = await getCurrentPendingCartRef(userId);
    if (cartSnapshot.empty) {
        logWarning(`No pending cart found for user: ${userId}`)
        throw new HttpsError('not-found',
            'No pending cart found for this user.'
        );
    }

    // Get the cart document
    const cartDocument = cartSnapshot.docs[0];
    const cartData = cartDocument.data() as CartData;
    logInfo(`Retrieved cart data: ${JSON.stringify(cartData)}`)

    return {cart: cartData};
});

// Function to clear the cart
export const clear_cart = onCall(async ({auth}) => {
    logInfo(`Function clear_cart called`)

    // Check if the user is authenticated
    const userId = checkAuth(auth);

    // Get the current pending cart
    const cartSnapshot = await getCurrentPendingCartRef(userId);
    if (cartSnapshot.empty) {
        logWarning(`No pending cart found for user: ${userId}`);
        throw new HttpsError('not-found',
            'No pending cart found for this user.'
        );
    }

    // Get the cart document
    const cartDocument = cartSnapshot.docs[0];

    await cartDocument.ref.update({products: {}});
    logInfo(`Cart cleared successfully for user: ${userId}`);

    return {message: 'Cart cleared successfully.'};
});

// Function to check out the cart
export const checkout_cart = onCall(async ({auth}) => {
    logInfo(`Function checkout_cart called`)

    // Check if the user is authenticated
    const userId = checkAuth(auth)

    // Get the current pending cart
    const cartSnapshot = await getCurrentPendingCartRef(userId);
    if (cartSnapshot.empty) {
        logWarning(`No pending cart found for user: ${userId}`);
        throw new HttpsError('not-found',
            'No pending cart found for this user.'
        );
    }

    // Get the cart document
    const cartDocument = cartSnapshot.docs[0];

    // Perform checkout logic here (e.g., payment processing, order creation)

    // Update the cart status to 'completed'
    await cartDocument.ref.update({status: 'completed'});
    logInfo(`Checkout completed successfully for user: ${userId}`);

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
export const create_product = onCall(async ({data, auth}: { data: CreateProductData, auth?: AuthData }) => {
    logInfo(`Function create_product called`);

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

    // Save the product to Firestore
    const productRef = await firestore.collection('products').add(newProduct);
    logInfo(`Product created successfully with ID: ${productRef.id}`);

    return {message: 'Product created successfully.', productId: productRef.id};
});

// Get products data
type GetProductsData = {
    limit: number,
    offset: number,
}

// Function to get products
export const get_products = onCall(async ({data}: { data: GetProductsData }) => {
    logInfo(`Function get_products called`);

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
    const products: Record<string, ProductData> = {};
    productSnapshot.forEach(doc => {
        products[doc.id] = doc.data() as ProductData;
    });
    logInfo(`Retrieved products: ${JSON.stringify(products)}`);

    // Get the total count of active products
    const totalCountSnapshot = await firestore.collection('products').where(
        'active',
        '==',
        true
    ).count().get();
    const totalCount = totalCountSnapshot.data().count;

    return {products, totalCount}
});

// Get product by ID data
type GetProductByIdData = {
    productId: string,
}

// Function to get a product by ID
export const get_product_by_id = onCall(async ({data, auth}: { data: GetProductByIdData, auth?: AuthData }) => {
    logInfo(`Function get_product_by_id called`);

    // Check if the user is authenticated
    const userId = checkAuth(auth);

    // Validate input data
    const {productId} = data;
    validateEmptyStringField(productId, 'Product ID');

    // Get the product data
    const [productRef, productData] = await getProductDataById(productId);
    logInfo(`Retrieved product data: ${JSON.stringify(productData)}`);

    // Check if the product is active if the user is not the owner
    if (productData.owner !== userId) {
        logWarning(`User ${userId} is not the owner of product ${productId}`);
        await checkProductActive(productData);
    } else {
        logInfo(`User ${userId} is the owner of product ${productId}`);
    }

    return {id: productRef.id, ...productData};
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
export const update_product = onCall(async ({data, auth}: { data: UpdateProductData, auth?: AuthData }) => {
    logInfo(`Function update_product called`);

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
        logWarning(`User ${userId} is not the owner of product ${productId}`);
        throw new HttpsError('permission-denied',
            'You are not the owner of this product.'
        );
    }

    await productRef.update({...updates});
    logInfo(`Product ${productId} updated successfully`);

    return {message: 'Product updated successfully.'};
});

// Remove product data
type RemoveProductData = {
    productId: string,
}

// Function to remove a product
export const remove_product = onCall(async ({data, auth}: { data: RemoveProductData, auth?: AuthData }) => {
    logInfo(`Function remove_product called`);

    // Check if the user is authenticated
    const userId = checkAuth(auth);

// Validate input data
    const {productId} = data;
    validateEmptyStringField(productId, 'Product ID');

    // Get the product data
    const [productRef, productData] = await getProductDataById(productId);
    if (productData.owner !== userId) {
        logWarning(`User ${userId} is not the owner of product ${productId}`);
        throw new HttpsError('permission-denied',
            'You are not the owner of this product.'
        );
    }

    await productRef.delete();
    logInfo(`Product ${productId} removed successfully`);

    return {message: 'Product removed successfully.'};
});