import { Link, type LinkProps } from 'react-router-dom';
import { buttonClasses, type ButtonSize, type ButtonVariant } from './button';

interface LinkButtonProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** A react-router Link styled exactly like <Button> — for a primary action that navigates
 * rather than submits, so we never nest an <a> inside a <button>. */
export function LinkButton({ variant = 'primary', size = 'md', className, ...props }: LinkButtonProps) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}
