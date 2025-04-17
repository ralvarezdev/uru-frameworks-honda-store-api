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
        [key: string]: {
            id: string,
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

// Validate if the field is a non-empty string
function validateEmptyStringField(fieldValue: string, fieldName: string) {
    if (!fieldValue || fieldValue?.trim() === '') {
        logWarning(`Invalid argument: ${fieldName} must be a non-empty string`);
        throw new HTTPError(`${fieldName} must be a non-empty string`, 400);
    }
}

// Validate if the field is a positive number
function validatePositiveNumberField(fieldValue: number, fieldName: string) {
    if (!fieldValue || fieldValue <= 0) {
        logWarning(`Invalid argument: ${fieldName} must be a positive number`);
        throw new HTTPError(`${fieldName} must be a positive number`, 400);
    }
}

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
            validateEmptyStringField(mappedFields[mappedFieldKey], mappedFieldKey);
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
        const {productId = null, quantity = null} = req.body
        validateEmptyStringField(productId, 'Product ID');
        validatePositiveNumberField(quantity, 'Quantity');
        logInfo(`Adding product ${productId} with quantity ${quantity} to cart for user ${decodedIdToken.uid}`);

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore, decodedIdToken);

        // Get the product data
        const [, productData] = await getProductDataById(firestore, productId);

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
        const {productId = null} = req.body;
        validateEmptyStringField(productId, 'Product ID');

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore,  decodedIdToken);
        if (cartSnapshot.empty) {
            logWarning(`No pending cart found for user: ${decodedIdToken.uid}`);
            throw new HTTPError('No pending cart found for this user', 404);
        }

        // Get the cart document
        const cartDocument = cartSnapshot.docs[0];
        const cartData = cartDocument.data() as CartData;
        if (!cartData?.products[productId]) {
            logWarning(`Product ${productId} not found in the cart`);
            throw new HTTPError('Product not found in the cart', 404);
        }

        // Remove the product from the cart
        const updatedProducts = {...cartData.products};
        delete updatedProducts[productId];

        await cartDocument.ref.update({products: updatedProducts});
        logInfo(`Product ${productId} removed from cart successfully`);

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
        const {productId = null, quantity = null} = req.body;
        validateEmptyStringField(productId, 'Product ID');
        validatePositiveNumberField(quantity, 'Quantity');

        // Get the current pending cart
        const cartSnapshot = await getCurrentPendingCartRef(firestore,  decodedIdToken);
        if (cartSnapshot.empty) {
            logWarning(`No pending cart found for user: ${decodedIdToken.uid}`);
            throw new HTTPError('No pending cart found for this user', 404);
        }

        // Get the cart document
        const cartDocument = cartSnapshot.docs[0];
        const cartData = cartDocument.data() as CartData;
        if (!cartData?.products[productId]) {
            logWarning(`Product ${productId} not found in the cart`)
            throw new HTTPError('Product not found in the cart', 404);
        }

        // Get the product data
        const [, productData] = await getProductDataById(firestore, productId);

        // Check if the product is active
        await checkProductActive(productData);

        // Check if the product has stock
        await checkProductStock(productData, quantity);

        const updatedProducts = {...cartData.products};
        updatedProducts[productId].quantity = quantity;

        await cartDocument.ref.update({products: updatedProducts});
        logInfo(`Product ${productId} quantity updated to ${quantity} in cart`)

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
            image_url = null
        } = req.body;
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
            owner: decodedIdToken.uid,
            image_url: image_url,
        };

        // Save the product to Firestore
        const productRef = await firestore.collection('products').add(newProduct);
        logInfo(`Product created successfully with ID: ${productRef.id}`);

        res.status(200).send({message: 'Product created successfully'});
    })
);

// Function to get products
export const get_products = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function get_products called`);

        // Validate input data
        const {limit = 10, offset = 0} = req.body;
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

        res.status(200).send({
            products: products,
            totalCount: totalCount,
        });
    })
);

// Function to get a product by ID
export const get_product_by_id = onRequestWithCORS(
    handleRequestError(async (req: Request, res: Response) => {
        logInfo(`Function get_product_by_id called`);

        // Check if the user is authenticated
        const decodedIdToken = await checkAuth(req);

        // Validate input data
        const {productId = null} = req.body;
        validateEmptyStringField(productId, 'Product ID');

        // Get the product data
        const [, productData] = await getProductDataById(firestore, productId);
        logInfo(`Retrieved product data: ${JSON.stringify(productData)}`);

        // Check if the product is active if the user is not the owner
        if (productData.owner !== decodedIdToken.uid) {
            logWarning(`User ${decodedIdToken.uid} is not the owner of product ${productId}`);
            await checkProductActive(productData);
        } else {
            logInfo(`User ${decodedIdToken.uid} is the owner of product ${productId}`);
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
            productId = null,
            title = null,
            description = null,
            price = null,
            stock = null,
            active = null,
            brand = null,
            tags = null,
            image_url = null
        } = req.body;
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
        const [productRef, productData] = await getProductDataById(firestore, productId);
        if (productData.owner !== decodedIdToken.uid) {
            logWarning(`User ${decodedIdToken.uid} is not the owner of product ${productId}`);
            throw new HTTPError('You are not the owner of this product', 403);
        }

        await productRef.update({...updates});
        logInfo(`Product ${productId} updated successfully`);

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
        const {productId = null} = req.body;
        validateEmptyStringField(productId, 'Product ID');

        // Get the product data
        const [productRef, productData] = await getProductDataById(firestore, productId);
        if (productData.owner !== decodedIdToken.uid) {
            logWarning(`User ${decodedIdToken.uid} is not the owner of product ${productId}`);
            throw new HTTPError('You are not the owner of this product', 403);
        }

        await productRef.delete();
        logInfo(`Product ${productId} removed successfully`);

        res.status(200).send({message: 'Product removed successfully'})
    })
);