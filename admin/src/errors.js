export class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export const conflict = () => new ApiError(409, 'conflict', 'Content changed in the repository. Reload before publishing.');
