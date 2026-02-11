import requests
import csv
import time
import urllib.parse  # <--- Added to fix the URL errors

# --- CONFIGURATION ---
START_YEAR = 1990
END_YEAR = 2026
OUTPUT_FILE = "vehicle_master_list.csv"
BASE_URL = "https://vpic.nhtsa.dot.gov/api/vehicles"

# ONLY fetch these brands to avoid errors and junk data
# You can add more (e.g., 'TESLA', 'RIVIAN') if needed.
MAJOR_BRANDS = {
    "ACURA", "ALFA ROMEO", "AUDI", "BMW", "BUICK", "CADILLAC", "CHEVROLET",
    "CHRYSLER", "DODGE", "FIAT", "FORD", "GENESIS", "GMC", "HONDA", "HYUNDAI",
    "INFINITI", "JAGUAR", "JEEP", "KIA", "LAND ROVER", "LEXUS", "LINCOLN",
    "LUCID", "MAZDA", "MERCEDES-BENZ", "MINI", "MITSUBISHI", "NISSAN", "POLESTAR",
    "PORSCHE", "RAM", "RIVIAN", "SUBARU", "TESLA", "TOYOTA", "VOLKSWAGEN", "VOLVO"
}

def get_json(url):
    """Helper to get JSON safely."""
    try:
        response = requests.get(url)
        # Check if the response is actually valid JSON
        if response.status_code == 200 and "application/json" in response.headers.get("Content-Type", ""):
            return response.json().get("Results", [])
    except Exception:
        pass  # Skip silently if it fails
    return []

def main():
    unique_vehicles = set()
    
    print(f"Starting optimized scrape for years {START_YEAR} to {END_YEAR}...")

    for year in range(START_YEAR, END_YEAR + 1):
        print(f"Processing Year: {year}")
        
        # We iterate through our APPROVED list instead of asking the API for 'All Makes'
        # This is much faster and prevents the errors you saw.
        for make in sorted(MAJOR_BRANDS):
            
            # 1. URL Encode the make (Fixes the "Expecting value" error)
            safe_make = urllib.parse.quote(make)
            
            url = f"{BASE_URL}/GetModelsForMakeYear/make/{safe_make}/modelyear/{year}?format=json"
            models = get_json(url)

            if models:
                print(f"  > {make}: Found {len(models)} models")
            
            for model in models:
                model_name = model.get("Model_Name", "").strip().upper()
                
                # Filter out garbage models if necessary
                if not model_name: continue

                # Store as (Year, Make, Model)
                unique_vehicles.add((year, make, model_name))
            
            # Be polite to the API
            time.sleep(0.05)

    # Write to CSV
    print(f"\nWriting {len(unique_vehicles)} vehicles to {OUTPUT_FILE}...")
    
    with open(OUTPUT_FILE, mode='w', newline='', encoding='utf-8') as file:
        writer = csv.writer(file)
        writer.writerow(["Year", "Make", "Model", "Full_Search_String"])
        
        for year, make, model in sorted(list(unique_vehicles), reverse=True):
            search_string = f"{year} {make} {model}"
            writer.writerow([year, make, model, search_string])

    print("Done! File saved.")

if __name__ == "__main__":
    main()
