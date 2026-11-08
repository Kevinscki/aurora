import sys

def calculate_growth(principal, rate, years):
    return principal * (1 + rate)**years

def main():
    print("--- Kelvin's Economics Engine v1.0 ---")
    try:
        p = float(input("Enter current principal (USD): "))
        r = float(input("Enter expected annual growth rate (e.g., 0.10 for 10%): "))
        y = int(input("Enter time horizon (years): "))
        
        future_val = calculate_growth(p, r, y)
        print(f"\nProjected Value after {y} years: ${future_val:,.2f}")
        print(f"Total Growth: ${future_val - p:,.2f}")
    except ValueError:
        print("Invalid input. Please enter numbers.")

if __name__ == "__main__":
    main()
