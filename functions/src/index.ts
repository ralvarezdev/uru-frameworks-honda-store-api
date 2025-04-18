import {cert, initializeApp, ServiceAccount} from 'firebase-admin/app';
import {DocumentReference, Firestore, getFirestore} from 'firebase-admin/firestore';
import serviceAccount from '../../uru-frameworks-honda-store-firebase-adminsdk.json';
import config from '../../config.json'
import {Logging} from '@google-cloud/logging';
import {onRequest} from "firebase-functions/v2/https";
import {Request, Response} from "express"
import {DecodedIdToken, getAuth} from "firebase-admin/auth";
import cors from 'cors'

// Set to true to enable logging
const DEBUG = true;

// --- CORS

// Initialize CORS middleware
const corsHandler = cors({
    origin: true, // Allow all origins. You can specify a specific origin or an array of origins.
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Allowed HTTP methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
    credentials: true, // Allow credentials
});

// On request with CORS middleware
function onRequestWithCORS(fn: (req: Request, res: Response) => void | Promise<void>) {
    return onRequest(async (req, res) => {
        // Log the request only if DEBUG is true
        if (DEBUG) {
            logInfo(`Request body: ${JSON.stringify(req.body)}`);
            logInfo(`Request headers: ${JSON.stringify(req.headers)}`);
        }

        // Call the CORS middleware
        corsHandler(req, res, async () => {
            // Check if it's a promise
            if (fn.constructor.name === 'AsyncFunction') {
                await fn(req, res);
            } else {
                fn(req, res);
            }
        });
    })
}

// --- LOGGING

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
        [product_id: string]: {
            price: number,
            quantity: number,
        }
    }
}

// Initialize the Firebase Admin SDK
const app = initializeApp({
    credential: cert(serviceAccount as ServiceAccount),
});

// Firebase Auth instance
const auth = getAuth(app);


// Firebase Firestore instance
const firestore = getFirestore(config.database);

// Create a custom HTTP error with a status code and a message
class HTTPError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        Error.captureStackTrace(this, this.constructor);
    }
}

// Request HTTP error handler
function handleRequestError(fn: (req: Request, res: Response) => void | Promise<void>) {
    return async (req: Request, res: Response) => {
        try {
            // Log the request only if DEBUG is true
            if (DEBUG) {
                logInfo(`Request body: ${JSON.stringify(req.body)}`);
                logInfo(`Request headers: ${JSON.stringify(req.headers)}`);
            }

            // Check if it's a promise
            if (fn.constructor.name === 'AsyncFunction') {
                await fn(req, res);
            } else {
                fn(req, res);
            }
        } catch (error) {
            if (error instanceof HTTPError) {
                res.status(error.statusCode).json({error: error.message});
            } else {
                logWarning(`Error: ${error}`);
                res.status(500).json({error: 'Internal Server Error'});
            }
        }
    };
}

// Check if the user is authenticated
async function checkAuth(req: Request) {
    // Check if the user is authenticated
    const authorizationHeader = req.headers['Authorization'] as string || req.headers['authorization'] as string;

    // Validate the authorization header
    if (!authorizationHeader) {
        logWarning(`Authorization header not found`);
        throw new HTTPError('Authorization header not found', 401);
    }

    // Decode the token
    const token = authorizationHeader.split(' ')[1];

    // Validate the token
    if (!token) {
        logWarning(`Token not found`);
        throw new HTTPError('Token not found', 401);
    }

    try {
        // Verify the token
        const decodedIdToken = await auth.verifyIdToken(token)
        logInfo(`User authenticated with ID: ${decodedIdToken.uid}`);
        return decodedIdToken;
    } catch (error) {
        logWarning(`Token verification failed: ${error}`);
        throw new HTTPError('Token verification failed', 401);
    }
}

// Get the current pending cart reference for the user
async function getCurrentPendingCartRef(firestore: Firestore, decodedIdToken: DecodedIdToken) {
    // Log the action
    logInfo(`Getting pending cart for user: ${decodedIdToken.uid}`);

    // Query the Firestore collection for the user's cart
    const cartRef = firestore.collection('carts').where('owner',
        '==',
        decodedIdToken.uid
    ).where('status', '==', 'pending');
    return await cartRef.get();
}

// Get a product data by ID
async function getProductDataById(firestore: Firestore, productId: string): Promise<[DocumentReference, ProductData]> {
    // Log the action
    logInfo(`Getting product data for ID: ${productId}`);

    // Query the Firestore collection for the product
    const productRef = firestore.collection('products').doc(productId);
    const productSnapshot = await productRef.get();

    // Check if the product exists
    if (!productSnapshot.exists) {
        logWarning(`Product not found with ID: ${productId}`);
        throw new HTTPError('Product not found', 404);
    }

    return [productRef, productSnapshot.data() as ProductData];
}

// Check if the product is active
async function checkProductActive(productData: ProductData) {
    if (!productData?.active) {
        logWarning(`Product is inactive: ${productData.title}`);
        throw new HTTPError('Product is inactive', 400);
    }
}

// Check if the product has stock
async function checkProductStock(productData: ProductData, quantity: number) {
    if (productData?.stock <= 0) {
        logWarning(`Product "${productData.title}" is out of stock.`);
        throw new HTTPError('Product is out of stock', 400);
    }
    if (quantity && productData?.stock < quantity) {
        logWarning(`Not enough stock for product "${productData.title}". Requested: ${quantity}, Available: ${productData.stock}`);
        throw new HTTPError('Not enough stock', 400);
    }
}

// Validate if the field is a string
function validateStringField(fieldValue: any, fieldName: string) {
    if (typeof fieldValue !== 'string') {
        logWarning(`Invalid argument: ${fieldName} must be a string`);
        throw new HTTPError(`${fieldName} must be a string`, 400);
    }
}

// Validate if the field is a non-empty string
function validateNonEmptyStringField(fieldValue: any, fieldName: string) {
    validateStringField(fieldValue, fieldName);

    if (fieldValue?.trim() === '') {
        logWarning(`Invalid argument: ${fieldName} must be a non-empty string`);
        throw new HTTPError(`${fieldName} must be a non-empty string`, 400);
    }
}

// Validate if the field is a number
function validateNumberField(fieldValue: any, fieldName: string) {
    if (typeof fieldValue !== 'number') {
        logWarning(`Invalid argument: ${fieldName} must be a number`);
        throw new HTTPError(`${fieldName} must be a number`, 400);
    }
}

// Validate if the field is a positive number
function validatePositiveNumberField(fieldValue: any, fieldName: string) {
    validateNumberField(fieldValue, fieldName);

    if (fieldValue < 0 || fieldValue === Infinity) {
        logWarning(`Invalid argument: ${fieldName} must be a positive number`);
        throw new HTTPError(`${fieldName} must be a positive number`, 400);
    }
}

// Validate if the field is a positive non-zero number
function validatePositiveNonZeroNumberField(fieldValue: any, fieldName: string) {
    validateNumberField(fieldValue, fieldName);

    if (fieldValue <= 0 || fieldValue === Infinity) {
        logWarning(`Invalid argument: ${fieldName} must be a positive non-zero number`);
        throw new HTTPError(`${fieldName} must be a positive non-zero number`, 400);
    }
}

// Validate if the field is a boolean
function validateBooleanField(fieldValue: any, fieldName: string) {
    if (typeof fieldValue !== 'boolean') {
        logWarning(`Invalid argument: ${fieldName} must be a boolean`);
        throw new HTTPError(`${fieldName} must be a boolean`, 400);
    }
}

// Validate if the field is an array
function validateArrayField(fieldValue: any, fieldName: string) {
    if (!Array.isArray(fieldValue)) {
        logWarning(`Invalid argument: ${fieldName} must be an array`);
        throw new HTTPError(`${fieldName} must be an array`, 400);
    }
}

/*
// Validate if the field is a non-empty array
function validateNonEmptyArrayField(fieldValue: any, fieldName: string) {
    validateArrayField(fieldValue, fieldName);
    if (fieldValue.length === 0) {
        logWarning(`Invalid argument: ${fieldName} must be a non-empty array`);
        throw new HTTPError(`${fieldName} must be a non-empty array`, 400);
    }
}
 */

// Function to create a new user
export const create_user = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo('Function create_user called');

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Extract data from request body
        const {first_name = null, last_name = null} = req.body;
        const mappedFields: Record<string, any> = {
            'First name': first_name,
            'Last name': last_name,
        }
        for (const mappedFieldKey in mappedFields) {
            validateNonEmptyStringField(mappedFields[mappedFieldKey], mappedFieldKey);
        }

        // Create a new user object
        const newUser = {first_name, last_name};
        await firestore.collection('users').doc(decodedIdToken.uid).set(newUser);

        res.status(200).send({message: 'User created successfully'});
    })
);

// Function to get a user by ID
export const get_user_by_id = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo('Function get_user_by_id called');

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Retrieve the user document
        const userDoc = await firestore.collection('users').doc(decodedIdToken.uid).get();
        if (!userDoc.exists) {
            logWarning(`User not found with ID: ${decodedIdToken.uid}`);
            throw new HTTPError('User not found', 404);
        }

        // Return the user data
        const userData = userDoc.data() as UserData;
        logInfo(`Retrieved user data: ${JSON.stringify(userData)}`);

        res.status(200).send({user: userData});
    })
);

// Function to add a product to the cart
export const add_product_to_cart = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function add_product_to_cart called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {product_id = null, quantity = null} = req.body
        validateNonEmptyStringField(product_id, 'Product ID');
        validatePositiveNonZeroNumberField(quantity, 'Quantity');
        logInfo(`Adding product ${product_id} with quantity ${quantity} to cart for user ${decodedIdToken.uid}`);

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore, decodedIdToken);

        // Get the product data
        const [,productData] = await getProductDataById(firestore, product_id);

        // Check if the product is active
        await checkProductActive(productData);

        // Check if the product has stock
        await checkProductStock(productData, quantity);

        if (cartSnapshot.empty) {
            // Create a new cart
            const newCart = {
                owner: decodedIdToken.uid,
                status: 'pending',
                products: {
                    [product_id]: {
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
            const existingProduct = cartData.products && cartData.products[product_id];

            const updatedProducts = {...cartData.products};

            // Check if the product already exists in the cart
            if (existingProduct) {
                // Update the quantity of the existing product
                updatedProducts[product_id].quantity += quantity;
                logInfo(`Incrementing quantity of product "${productData.title}" in cart to ${updatedProducts[product_id].quantity}`);
            } else {
                updatedProducts[product_id] = {
                    price: productData.price,
                    quantity: quantity,
                };
                logInfo(`Adding product "${productData.title}" to existing cart`);
            }

            await cartDocument.ref.update({products: updatedProducts});
            logInfo(`Product "${productData.title}" added to cart successfully`);
        }

        res.status(200).send({message: 'Product added to cart successfully'});
    })
);

// Function to remove a product from the cart
export const remove_product_from_cart = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function remove_product_from_cart called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {product_id = null} = req.body;
        validateNonEmptyStringField(product_id, 'Product ID');

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore, decodedIdToken);
        if (cartSnapshot.empty) {
            logWarning(`No pending cart found for user: ${decodedIdToken.uid}`);
            throw new HTTPError('No pending cart found for this user', 404);
        }

        // Get the cart document
        const cartDocument = cartSnapshot.docs[0];
        const cartData = cartDocument.data() as CartData;
        if (!cartData?.products[product_id]) {
            logWarning(`Product ${product_id} not found in the cart`);
            throw new HTTPError('Product not found in the cart', 404);
        }

        // Remove the product from the cart
        const updatedProducts = {...cartData.products};
        delete updatedProducts[product_id];

        await cartDocument.ref.update({products: updatedProducts});
        logInfo(`Product ${product_id} removed from cart successfully`);

        res.status(200).send({message: 'Product removed from cart successfully'});
    })
);

// Function to update the quantity of a product in the cart
export const update_product_quantity_in_cart = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function update_product_quantity_in_cart called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {product_id = null, quantity = null} = req.body;
        validateNonEmptyStringField(product_id, 'Product ID');
        validatePositiveNonZeroNumberField(quantity, 'Quantity');

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore, decodedIdToken);
        if (cartSnapshot.empty) {
            logWarning(`No pending cart found for user: ${decodedIdToken.uid}`);
            throw new HTTPError('No pending cart found for this user', 404);
        }

        // Get the cart document
        const cartDocument = cartSnapshot.docs[0];
        const cartData = cartDocument.data() as CartData;
        if (!cartData?.products[product_id]) {
            logWarning(`Product ${product_id} not found in the cart`)
            throw new HTTPError('Product not found in the cart', 404);
        }

        // Get the product data
        const [, productData] = await getProductDataById(firestore, product_id);

        // Check if the product is active
        await checkProductActive(productData);

        // Check if the product has stock
        await checkProductStock(productData, quantity);

        const updatedProducts = {...cartData.products};
        updatedProducts[product_id].quantity = quantity;

        await cartDocument.ref.update({products: updatedProducts});
        logInfo(`Product ${product_id} quantity updated to ${quantity} in cart`)

        res.status(200).send({message: 'Product quantity updated successfully in cart'});
    })
);

// Function to get the cart
export const get_cart = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function get_cart called`)

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore, decodedIdToken);
        if (cartSnapshot.empty) {
            logWarning(`No pending cart found for user: ${decodedIdToken.uid}`)
            throw new HTTPError('No pending cart found for this user', 404);
        }

        // Get the cart document
        const cartDocument = cartSnapshot.docs[0];
        const cartData = cartDocument.data() as CartData;
        logInfo(`Retrieved cart data: ${JSON.stringify(cartData)}`)

        res.status(200).send({cart: cartData});
    })
);

// Function to clear the cart
export const clear_cart = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function clear_cart called`)

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore, decodedIdToken);
        if (cartSnapshot.empty) {
            logWarning(`No pending cart found for user: ${decodedIdToken.uid}`);
            throw new HTTPError('No pending cart found for this user', 404);
        }

        // Get the cart document
        const cartDocument = cartSnapshot.docs[0];

        await cartDocument.ref.update({products: {}});
        logInfo(`Cart cleared successfully for user: ${decodedIdToken.uid}`);

        res.status(200).send({message: 'Cart cleared successfully'});
    })
);

// Function to check out the cart
export const checkout_cart = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function checkout_cart called`)

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req)

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore, decodedIdToken);
        if (cartSnapshot.empty) {
            logWarning(`No pending cart found for user: ${decodedIdToken.uid}`);
            throw new HTTPError('No pending cart found for this user', 404);
        }

        // Get the cart document
        const cartDocument = cartSnapshot.docs[0];

        // Perform checkout logic here (e.g., payment processing, order creation)

        // Update the cart status to 'completed'
        await cartDocument.ref.update({status: 'completed'});
        logInfo(`Checkout completed successfully for user: ${decodedIdToken.uid}`);

        res.status(200).send({message: 'Checkout completed successfully'});
    })
);

// Function to create a new product
export const create_product = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function create_product called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {
            title = null,
            description = null,
            price = null,
            stock = null,
            active = null,
            brand = null,
            tags = null,
            image_url = null,
            sku = null,
        } = req.body;
        const mappedStringFields: Record<string, any> = {
            'Title': title,
            'Description': description,
            'Brand': brand,
            'Image URL': image_url,
            'SKU': sku,
        }
        const mappedPositiveNumberFields: Record<string, any> = {
            'Price': price,
            'Stock': stock,
        }
        for (const mappedFieldKey in mappedStringFields) {
            validateNonEmptyStringField(mappedStringFields[mappedFieldKey], mappedFieldKey);
        }
        for (const mappedFieldKey in mappedPositiveNumberFields) {
            validatePositiveNonZeroNumberField(mappedPositiveNumberFields[mappedFieldKey], mappedFieldKey);
        }
        validateArrayField(tags, 'Tags');
        for (const [i, tag] of tags) {
            validateNonEmptyStringField(tag, 'Tag on index ' + i);
        }
        validateBooleanField(active, 'Active');

        // Create a new product object
        const newProduct = {
            title,
            description,
            price,
            stock,
            active,
            brand,
            tags: Array.isArray(tags) ? tags : [],
            owner: decodedIdToken.uid,
            image_url,
            sku,
            created_at: new Date(),
        };

        // Save the product to Firestore
        const productRef = await firestore.collection('products').add(newProduct);
        logInfo(`Product created successfully with ID: ${productRef.id}`);

        res.status(200).send({message: 'Product created successfully'});
    })
);

// Function to get a product by ID
export const get_product_by_id = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function get_product_by_id called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {product_id = null} = req.body;
        validateNonEmptyStringField(product_id, 'Product ID');

        // Get the product data
        const [, productData] = await getProductDataById(firestore, product_id);
        logInfo(`Retrieved product data: ${JSON.stringify(productData)}`);

        // Check if the product is active if the user is not the owner
        if (productData.owner !== decodedIdToken.uid) {
            logWarning(`User ${decodedIdToken.uid} is not the owner of product ${product_id}`);
            await checkProductActive(productData);
        } else {
            logInfo(`User ${decodedIdToken.uid} is the owner of product ${product_id}`);
        }

        res.status(200).send({product: productData})
    })
);

// Function to update a product
export const update_product = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function update_product called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {
            product_id = null,
            title = null,
            description = null,
            price = null,
            stock = null,
            active = null,
            brand = null,
            tags = null,
            image_url = null,
            sku = null,
        } = req.body;
        validateNonEmptyStringField(product_id, 'Product ID');

        // Build the updates object
        const updates: Record<string, any> = {};
        const mappedStringFields: Record<string, any> = {
            'Title': title,
            'Description': description,
            'Brand': brand,
            'Image URL': image_url,
            'SKU': sku,
        }
        const mappedPositiveNumberFields: Record<string, any> = {
            'Price': price,
            'Stock': stock,
        }
        for (const mappedFieldKey in mappedStringFields) {
            if (mappedStringFields[mappedFieldKey] !== null) {
                validateNonEmptyStringField(mappedStringFields[mappedFieldKey], mappedFieldKey);
                updates[mappedFieldKey.toLowerCase().replace(' ', '_')] = mappedStringFields[mappedFieldKey];
            }
        }
        for (const mappedFieldKey in mappedPositiveNumberFields) {
            if (mappedPositiveNumberFields[mappedFieldKey] !== null) {
                validatePositiveNonZeroNumberField(mappedPositiveNumberFields[mappedFieldKey], mappedFieldKey);
                updates[mappedFieldKey.toLowerCase().replace(' ', '_')] = mappedPositiveNumberFields[mappedFieldKey];
            }
        }
        if (active !== null) {
            validateBooleanField(active, 'Active');
            updates.active = active;
        }
        if (tags !== null) {
            validateArrayField(tags, 'Tags');
            for (const [i, tag] of tags) {
                validateNonEmptyStringField(tag, 'Tag on index ' + i);
            }
            updates.tags = tags;
        }

        // Get the product data
        const [productRef, productData] = await getProductDataById(firestore, product_id);
        if (productData.owner !== decodedIdToken.uid) {
            logWarning(`User ${decodedIdToken.uid} is not the owner of product ${product_id}`);
            throw new HTTPError('You are not the owner of this product', 403);
        }

        await productRef.update({...updates});
        logInfo(`Product ${product_id} updated successfully`);

        res.status(200).send({message: 'Product updated successfully'})
    })
);

// Function to remove a product
export const remove_product = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function remove_product called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {product_id = null} = req.body;
        validateNonEmptyStringField(product_id, 'Product ID');

        // Get the product data
        const [productRef, productData] = await getProductDataById(firestore, product_id);
        if (productData.owner !== decodedIdToken.uid) {
            logWarning(`User ${decodedIdToken.uid} is not the owner of product ${product_id}`);
            throw new HTTPError('You are not the owner of this product', 403);
        }

        await productRef.delete();
        logInfo(`Product ${product_id} removed successfully`);

        res.status(200).send({message: 'Product removed successfully'})
    })
);

// Get my products
export const get_my_products = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function get_my_products called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {limit = 10, offset = 0} = req.body;
        validatePositiveNonZeroNumberField(limit, 'Limit');
        validatePositiveNumberField(offset, 'Offset');

        // Get the products for the authenticated user
        let productsRef = firestore.collection('products')
            .where('owner', '==', decodedIdToken.uid)

        // Apply pagination
        const totalCountSnapshot = await productsRef.count().get()
        const totalCount = totalCountSnapshot.data().count;
        productsRef = productsRef
            .limit(limit)
            .offset(offset);

        // Get the products
        const productSnapshot = await productsRef.get();
        const products: Record<string, ProductData> = {};
        productSnapshot.forEach(doc => {
            products[doc.id] = doc.data() as ProductData;
        });
        logInfo(`Retrieved products: ${JSON.stringify(products)}`);

        res.status(200).send({
            products,
            total_count: totalCount,
        });
    })
);

// Search products
export const search_products = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function search_products called`);

        // Check if the user is authenticated
        await checkAuth(req);

        // Validate input data
        const {
            title = null,
            min_price = null,
            max_price = null,
            min_stock = null,
            max_stock = null,
            min_created_at = null,
            max_created_at = null,
            limit = 10,
            offset = 0
        } = req.body;
        validateNonEmptyStringField(title, 'Title');
        validatePositiveNonZeroNumberField(limit, 'Limit');
        validatePositiveNumberField(offset, 'Offset');

        // Get the products for the authenticated user
        let productsRef = firestore.collection('products')
            .where('active', '==', true)
            .where("title", ">=", title)
            .where("title", "<=", title + "\uf8ff");

        // Apply filters
        if (min_price !== null) {
            validatePositiveNumberField(min_price, 'Minimum Price');
            productsRef = productsRef.where('price', '>=', min_price);
        }
        if (max_price !== null) {
            validatePositiveNumberField(max_price, 'Maximum Price');
            productsRef = productsRef.where('price', '<=', max_price);
        }
        if (min_stock !== null) {
            validatePositiveNumberField(min_stock, 'Minimum Stock');
            productsRef = productsRef.where('stock', '>=', min_stock);
        }
        if (max_stock !== null) {
            validatePositiveNumberField(max_stock, 'Maximum Stock');
            productsRef = productsRef.where('stock', '<=', max_stock);
        }
        if (min_created_at !== null) {
            validateStringField(min_created_at, 'Minimum Created At');
            productsRef = productsRef.where('created_at', '>=', new Date(min_created_at));
        }
        if (max_created_at !== null) {
            validateStringField(max_created_at, 'Maximum Created At');
            productsRef = productsRef.where('created_at', '<=', new Date(max_created_at));
        }

        // Apply pagination
        const totalCountSnapshot = await productsRef.count().get()
        const totalCount = totalCountSnapshot.data().count;
        productsRef = productsRef.limit(limit).offset(offset)

        // Get the products
        const productsSnapshot = await productsRef.get();
        const products: Record<string, ProductData> = {};
        productsSnapshot.forEach(doc => {
            products[doc.id] = doc.data() as ProductData;
        });
        logInfo(`Retrieved products: ${JSON.stringify(products)}`);

        res.status(200).send({
            products,
            total_count: totalCount,
        });
    })
);

// Search my products
export const search_my_products = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function search_my_products called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {title = null, limit = 10, offset = 0} = req.body;
        validateNonEmptyStringField(title, 'Title');
        validatePositiveNonZeroNumberField(limit, 'Limit');
        validatePositiveNumberField(offset, 'Offset');

        // Get the products for the authenticated user
        let productsRef = firestore.collection('products')
            .where('owner', '==', decodedIdToken.uid)
            .where("title", ">=", title)
            .where("title", "<=", title + "\uf8ff");

        // Apply pagination
        const totalCountSnapshot = await productsRef.count().get()
        const totalCount = totalCountSnapshot.data().count;
        let productRef = productsRef.limit(limit).offset(offset)

        // Get the products
        const productSnapshot = await productRef.get();
        const products: Record<string, ProductData> = {};
        productSnapshot.forEach(doc => {
            products[doc.id] = doc.data() as ProductData;
        });

        logInfo(`Retrieved products: ${JSON.stringify(products)}`);

        res.status(200).send({
            products,
            total_count: totalCount,
        });
    })
);

// Get the latest products
export const get_latest_products = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function get_latest_products called`);

        // Validate input data
        const {limit = 10, offset = 0} = req.body;
        validatePositiveNonZeroNumberField(limit, 'Limit');
        validatePositiveNumberField(offset, 'Offset');

        // Get the latest products
        let productsRef = firestore.collection('products')
            .where('active', '==', true)
            .orderBy('created_at', 'desc');

        // Apply pagination
        const totalCountSnapshot = await productsRef.count().get()
        const totalCount = totalCountSnapshot.data().count;
        productsRef = productsRef.limit(limit).offset(offset)

        // Get the products
        const productSnapshot = await productsRef.get();
        const products: Record<string, ProductData> = {};
        productSnapshot.forEach(doc => {
            products[doc.id] = doc.data() as ProductData;
        });

        logInfo(`Retrieved products: ${JSON.stringify(products)}`);

        res.status(200).send({
            products,
            total_count: totalCount,
        });
    })
);