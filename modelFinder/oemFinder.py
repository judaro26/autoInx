import pandas as pd
import requests
import time
import random
import json
import os

# --- CONFIGURATION ---
INPUT_FILE = 'vehicle_master_list_ready_for_scrape.csv'
OUTPUT_FILE = 'vehicle_parts_results.csv'
CHECKPOINT_INTERVAL = 10  # Save every 10 vehicles
DELAY_RANGE = (1.5, 3.5)  # Seconds to wait between requests to avoid blocks

# Mapping your columns to RockAuto's internal category names
PART_CATEGORIES = {
    'Brake_Pads_Front': 'Brake Pad',
    'Wipers_Front': 'Wiper Blade',
    'Headlight_Bulb': 'Headlight Bulb',
    'Stop_Light_Bulb': 'Stop Light Bulb',
    'Spark_Plugs': 'Spark Plug',
    'Bumper_Grille': 'Grille'
}

class RockAutoScraper:
    def __init__(self):
        self.base_url = "https://www.rockauto.com/catalog/catalogapi.php"
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
        })

    def get_data(self, payload):
        try:
            response = self.session.post(self.base_url, data={'payload': json.dumps(payload), 'func': 'get_children'})
            if response.status_code == 200:
                return response.json()
        except Exception as e:
            print(f"Connection error: {e}")
        return None

    def scrape_vehicle(self, year, make, model):
        results = {col: "" for col in PART_CATEGORIES}
        results['Engine'] = "Not Found"

        # 1. Get Make ID
        # RockAuto root node is 'root'
        res = self.get_data({"k": "root"})
        if not res: return results
        
        make_node = next((n for n in res['nodes'] if n['text'].upper() == make.upper()), None)
        if not make_node: return results

        # 2. Get Year ID
        res = self.get_data({"k": make_node['key']})
        year_node = next((n for n in res['nodes'] if n['text'] == str(year)), None)
        if not year_node: return results

        # 3. Get Model ID
        res = self.get_data({"k": year_node['key']})
        model_node = next((n for n in res['nodes'] if n['text'].upper() == model.upper()), None)
        if not model_node: return results

        # 4. Get Engine ID (Take the first one available)
        res = self.get_data({"k": model_node['key']})
        if not res['nodes']: return results
        engine_node = res['nodes'][0]
        results['Engine'] = engine_node['text']

        # 5. Navigate categories to find parts
        # This is a recursive-style search for simplicity
        res = self.get_data({"k": engine_node['key']})
        for cat_node in res['nodes']:
            cat_text = cat_node['text']
            
            # Drill into Category (e.g., 'Brake & Wheel Hub')
            sub_res = self.get_data({"k": cat_node['key']})
            for type_node in sub_res['nodes']:
                type_text = type_node['text']
                
                # Match against our requirements
                for col, target_name in PART_CATEGORIES.items():
                    if target_name.lower() in type_text.lower() and not results[col]:
                        # Get actual parts in this type
                        parts_res = self.get_data({"k": type_node['key']})
                        if parts_res and 'parts' in parts_res:
                            # Pick the first brand and part number
                            p = parts_res['parts'][0]
                            results[col] = f"{p['manufacturer']} {p['part_number']}"
        
        return results

def main():
    scraper = RockAutoScraper()
    
    # Load Progress
    if os.path.exists(OUTPUT_FILE):
        df = pd.read_csv(OUTPUT_FILE)
    else:
        df = pd.read_csv(INPUT_FILE)

    print(f"Starting scrape for {len(df)} vehicles...")

    for i, row in df.iterrows():
        # Check if row is already done (Engine is filled)
        if pd.notna(row.get('Engine')) and row['Engine'] != "":
            continue

        print(f"[{i+1}/{len(df)}] Fetching: {row['Year']} {row['Make']} {row['Model']}...")
        
        real_data = scraper.scrape_vehicle(row['Year'], row['Make'], row['Model'])
        
        # Update DataFrame
        df.at[i, 'Engine'] = real_data['Engine']
        for col in PART_CATEGORIES:
            df.at[i, col] = real_data[col]

        # Sleep to be polite
        time.sleep(random.uniform(*DELAY_RANGE))

        # Checkpoint save
        if (i + 1) % CHECKPOINT_INTERVAL == 0:
            df.to_csv(OUTPUT_FILE, index=False)
            print(">>> Checkpoint saved.")

    df.to_csv(OUTPUT_FILE, index=False)
    print("Processing Complete!")

if __name__ == "__main__":
    main()
