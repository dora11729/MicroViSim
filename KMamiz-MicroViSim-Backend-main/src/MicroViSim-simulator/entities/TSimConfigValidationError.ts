/**
 * Represents an error encountered during the validation or preprocessing
 * of the simulation configuration.
 * 
 * These error messages are collected and returned to the frontend
 * for users to review and correct their input.
 */
export type TSimConfigValidationError = {
  errorLocation: string;   // Description of where the error occurred
  message: string;
}