/** Built-in list of major cities for offline place search (lon, lat). */
export interface City {
  name: string;
  country: string;
  lon: number;
  lat: number;
}
const c = (name: string, country: string, lon: number, lat: number): City => ({ name, country, lon, lat });
export const CITIES: City[] = [
  c('Mumbai', 'India', 72.88, 19.08), c('Delhi', 'India', 77.21, 28.61), c('Kolkata', 'India', 88.36, 22.57), c('Chennai', 'India', 80.27, 13.08),
  c('Bengaluru', 'India', 77.59, 12.97), c('Hyderabad', 'India', 78.49, 17.39), c('Visakhapatnam', 'India', 83.22, 17.69), c('Bhubaneswar', 'India', 85.82, 20.3),
  c('Puri', 'India', 85.83, 19.81), c('Kochi', 'India', 76.27, 9.93), c('Ahmedabad', 'India', 72.57, 23.02), c('Dhaka', 'Bangladesh', 90.41, 23.81),
  c("Cox's Bazar", 'Bangladesh', 91.98, 21.43), c('Karachi', 'Pakistan', 67.01, 24.86), c('Colombo', 'Sri Lanka', 79.86, 6.93), c('Yangon', 'Myanmar', 96.2, 16.87),
  c('Muscat', 'Oman', 58.41, 23.59), c('Dubai', 'UAE', 55.27, 25.2), c('Riyadh', 'Saudi Arabia', 46.72, 24.71), c('Tehran', 'Iran', 51.39, 35.69),
  c('Istanbul', 'Turkey', 28.98, 41.01), c('Cairo', 'Egypt', 31.24, 30.04), c('Lagos', 'Nigeria', 3.38, 6.52), c('Nairobi', 'Kenya', 36.82, -1.29),
  c('Johannesburg', 'South Africa', 28.05, -26.2), c('Cape Town', 'South Africa', 18.42, -33.92), c('Antananarivo', 'Madagascar', 47.52, -18.88),
  c('London', 'United Kingdom', -0.13, 51.51), c('Paris', 'France', 2.35, 48.86), c('Berlin', 'Germany', 13.4, 52.52), c('Madrid', 'Spain', -3.7, 40.42),
  c('Rome', 'Italy', 12.5, 41.9), c('Moscow', 'Russia', 37.62, 55.76), c('Reykjavik', 'Iceland', -21.94, 64.15),
  c('Beijing', 'China', 116.41, 39.9), c('Shanghai', 'China', 121.47, 31.23), c('Hong Kong', 'China', 114.17, 22.32), c('Guangzhou', 'China', 113.26, 23.13),
  c('Taipei', 'Taiwan', 121.57, 25.03), c('Tokyo', 'Japan', 139.69, 35.69), c('Osaka', 'Japan', 135.5, 34.69), c('Okinawa', 'Japan', 127.68, 26.21),
  c('Seoul', 'South Korea', 126.98, 37.57), c('Manila', 'Philippines', 120.98, 14.6), c('Bangkok', 'Thailand', 100.5, 13.76), c('Hanoi', 'Vietnam', 105.85, 21.03),
  c('Ho Chi Minh City', 'Vietnam', 106.7, 10.78), c('Singapore', 'Singapore', 103.82, 1.35), c('Jakarta', 'Indonesia', 106.85, -6.21), c('Kuala Lumpur', 'Malaysia', 101.69, 3.14),
  c('Guam', 'USA', 144.79, 13.44), c('Sydney', 'Australia', 151.21, -33.87), c('Brisbane', 'Australia', 153.03, -27.47), c('Darwin', 'Australia', 130.84, -12.46),
  c('Perth', 'Australia', 115.86, -31.95), c('Auckland', 'New Zealand', 174.76, -36.85), c('Suva', 'Fiji', 178.44, -18.14),
  c('New York', 'USA', -74.01, 40.71), c('Miami', 'USA', -80.19, 25.76), c('New Orleans', 'USA', -90.07, 29.95), c('Houston', 'USA', -95.37, 29.76),
  c('Los Angeles', 'USA', -118.24, 34.05), c('San Francisco', 'USA', -122.42, 37.77), c('Honolulu', 'USA', -157.86, 21.31), c('Anchorage', 'USA', -149.9, 61.22),
  c('Mexico City', 'Mexico', -99.13, 19.43), c('Havana', 'Cuba', -82.37, 23.14), c('San Juan', 'Puerto Rico', -66.1, 18.47), c('Nassau', 'Bahamas', -77.35, 25.04),
  c('Toronto', 'Canada', -79.38, 43.65), c('Vancouver', 'Canada', -123.12, 49.28), c('Bogotá', 'Colombia', -74.07, 4.71), c('Lima', 'Peru', -77.04, -12.05),
  c('São Paulo', 'Brazil', -46.63, -23.55), c('Rio de Janeiro', 'Brazil', -43.17, -22.91), c('Buenos Aires', 'Argentina', -58.38, -34.6), c('Santiago', 'Chile', -70.67, -33.45)
];
